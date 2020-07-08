import { Base64URLString } from '@simplewebauthn/typescript-types';
import fetch from 'node-fetch';
import { KJUR } from 'jsrsasign';
import base64url from 'base64url';

import { FIDO_AUTHENTICATOR_STATUS } from '../helpers/constants';
import toHash from '../helpers/toHash';
import validateCertificatePath from '../helpers/validateCertificatePath';
import convertASN1toPEM from '../helpers/convertASN1toPEM';
import convertAAGUIDToString from '../helpers/convertAAGUIDToString';

import parseJWT from './parseJWT';

// Cached WebAuthn metadata statements
type CachedAAGUID = {
  url: TOCEntry['url'];
  hash: TOCEntry['hash'];
  statusReports: TOCEntry['statusReports'];
  statement?: MetadataStatement;
  tocURL?: CachedMDS['url'];
};

// Cached MDS APIs from which TOCs are downloaded
type CachedMDS = {
  url: string;
  alg: string;
  no: number;
  nextUpdate: Date;
  rootCertURL: string;
  // Specify a query param, etc... to be appended to the end of a metadata statement URL
  // TODO: This will need to be extended later, for now support FIDO MDS API that requires an API
  // token passed as a query param
  metadataURLSuffix: string;
};

enum SERVICE_STATE {
  REFRESHING,
  READY,
}

/**
 * A basic service to coordinate interactions with the FIDO Metadata Service. This includes TOC
 * download and parsing, and on-demand requesting and caching of individual metadata statements.
 *
 * https://fidoalliance.org/metadata/
 */
class MetadataService {
  private mdsCache: { [url: string]: CachedMDS } = {};
  private statementCache: { [aaguid: string]: CachedAAGUID } = {};
  private state: SERVICE_STATE = SERVICE_STATE.READY;

  /**
   * Prepare the service to handle live data, or prepared data.
   *
   * If `process.env.ENABLE_MDS` is `'true'`, then the actual MDS API will be queried. Otherwise
   * known metadata statements can be provided as arguments.
   */
  async initialize(opts: {
    statements?: MetadataStatement[];
    mdsServers?: Pick<CachedMDS, 'url' | 'rootCertURL' | 'metadataURLSuffix'>[];
  }): Promise<void> {
    const { mdsServers, statements } = opts;

    this.state = SERVICE_STATE.REFRESHING;

    // If metadata statements are provided, load them into the cache
    if (statements?.length) {
      console.log(`Adding ${statements.length} statements to cache`);

      statements.forEach(statement => {
        // Only cache statements that are for FIDO2-compatible authenticators
        if (statement.aaguid) {
          this.statementCache[statement.aaguid] = {
            url: '',
            hash: '',
            statement,
            statusReports: [],
          };
        }
      });
    }

    // If MDS servers are provided, then process them and add their statements to the cache
    if (mdsServers?.length) {
      console.log(`Querying ${mdsServers.length} MDS services`);

      for (const server of mdsServers) {
        try {
          console.log(`Service: ${server.url}`);
          await this.downloadTOC({
            url: server.url,
            rootCertURL: server.rootCertURL,
            metadataURLSuffix: server.metadataURLSuffix,
            alg: '',
            no: 0,
            nextUpdate: new Date(0),
          });
        } catch (err) {
          // Notify of the error and move on
          console.error(`Error processing ${server.url}: ${err.message}`);
        }
      }
    }

    console.log('MDS cache:', JSON.stringify(Object.keys(this.mdsCache)));
    console.log('Statement cache:', JSON.stringify(Object.keys(this.statementCache)));

    this.state = SERVICE_STATE.READY;
  }

  /**
   * Get a metadata statement for a given aaguid. Defaults to returning a cached statement.
   *
   * This method will coordinate updating the TOC as per the `nextUpdate` property in the initial
   * TOC download.
   */
  async getStatement(aaguid: string | Buffer): Promise<MetadataStatement | undefined> {
    if (!aaguid) {
      return;
    }

    if (aaguid instanceof Buffer) {
      aaguid = convertAAGUIDToString(aaguid);
    }

    // If a TOC refresh is in progress then pause this until the service is ready
    await this.pauseUntilReady();

    // Try to grab a cached statement
    const cachedStatement = this.statementCache[aaguid];

    if (!cachedStatement) {
      // TODO: FIDO conformance requires this, but it seems excessive for WebAuthn. Investigate
      // later
      throw new Error(`Unlisted aaguid "${aaguid}" in TOC`);
    }

    console.debug('Found cached statement:', cachedStatement);

    // If the statement points to an MDS API, check the MDS' nextUpdate to see if we need to refresh
    if (cachedStatement.tocURL) {
      const mds = this.mdsCache[cachedStatement.tocURL];
      const now = new Date();
      if (now > mds.nextUpdate) {
        try {
          this.state = SERVICE_STATE.REFRESHING;
          await this.downloadTOC(mds);
        } finally {
          this.state = SERVICE_STATE.READY;
        }
      }
    }

    // Check to see if the this aaguid has a status report with a "compromised" status
    for (const report of cachedStatement.statusReports) {
      const { status } = report;
      if (
        status === 'USER_VERIFICATION_BYPASS' ||
        status === 'ATTESTATION_KEY_COMPROMISE' ||
        status === 'USER_KEY_REMOTE_COMPROMISE' ||
        status === 'USER_KEY_PHYSICAL_COMPROMISE'
      ) {
        throw new Error(`Detected compromised aaguid "${aaguid}"`);
      }
    }

    // If the statement hasn't been cached but came from an MDS TOC, then download it
    if (!cachedStatement.statement && cachedStatement.tocURL) {
      // Download the metadata statement if it's not been cached
      console.debug('Downloading statement from', cachedStatement.url);
      const resp = await fetch(cachedStatement.url);
      const data = await resp.text();
      const statement: MetadataStatement = JSON.parse(
        Buffer.from(data, 'base64').toString('utf-8'),
      );

      const mds = this.mdsCache[cachedStatement.tocURL];

      const hashAlg = mds?.alg === 'ES256' ? 'SHA256' : undefined;
      const calculatedHash = base64url.encode(toHash(data, hashAlg));

      if (calculatedHash === cachedStatement.hash) {
        console.log('hash matched, storing statement in cache');
        // Update the cached entry with the latest statement
        cachedStatement.statement = statement;
      } else {
        // From FIDO MDS docs: "Ignore the downloaded metadata statement if the hash value doesn't
        // match."
        cachedStatement.statement = undefined;
        throw new Error(`Downloaded metadata for aaguid "${aaguid}" but hash did not match`);
      }
    }

    return cachedStatement.statement;
  }

  /**
   * Download and process the latest TOC from MDS
   */
  private async downloadTOC(mds: CachedMDS) {
    const { url, no, rootCertURL, metadataURLSuffix } = mds;

    // Query MDS for the latest TOC
    console.debug(`Downloading TOC: ${url}`);
    const respTOC = await fetch(url);
    const data = await respTOC.text();

    // Break apart the JWT we get back
    const parsedJWT = parseJWT<MDSJWTTOCHeader, MDSJWTTOCPayload>(data);
    const header = parsedJWT[0];
    const payload = parsedJWT[1];

    if (payload.no <= no) {
      // From FIDO MDS docs: "also ignore the file if its number (no) is less or equal to the
      // number of the last Metadata TOC object cached locally."
      throw new Error(`Latest TOC no. "${payload.no}" is not greater than previous ${no}`);
    }

    let fullCertPath = header.x5c.map(convertASN1toPEM);
    if (rootCertURL.length > 0) {
      console.debug(`Downloading root cert: ${rootCertURL}`);
      // Download FIDO the root certificate and append it to the TOC certs
      const respFIDORootCert = await fetch(rootCertURL);
      const fidoRootCert = await respFIDORootCert.text();
      fullCertPath = fullCertPath.concat(fidoRootCert);
    }

    try {
      // Validate the certificate chain
      // TODO: Check for certificate revocation
      await validateCertificatePath(fullCertPath);
    } catch (err) {
      // From FIDO MDS docs: "ignore the file if the chain cannot be verified or if one of the
      // chain certificates is revoked"
      throw new Error('TOC certificate path could not be validated');
    }

    // Verify the TOC JWT signature
    const leafCert = fullCertPath[0];
    const verified = KJUR.jws.JWS.verifyJWT(data, leafCert, {
      alg: [header.alg],
      // Empty values to appease TypeScript and this library's subtly mis-typed @types definitions
      aud: [],
      iss: [],
      sub: [],
    });

    if (!verified) {
      // From FIDO MDS docs: "The FIDO Server SHOULD ignore the file if the signature is invalid."
      throw new Error('TOC signature could not be verified');
    }

    console.log(`TOC verified, caching ${payload.entries.length} statements`);

    // Prepare the in-memory cache of statements.
    for (const entry of payload.entries) {
      // Only cache entries with an `aaguid`
      if (entry.aaguid) {
        const _entry = entry as TOCAAGUIDEntry;
        const cached: CachedAAGUID = {
          url: `${entry.url}${metadataURLSuffix}`,
          hash: entry.hash,
          statusReports: entry.statusReports,
          // An easy way for us to link back to a cached MDS API entry
          tocURL: url,
        };

        this.statementCache[_entry.aaguid] = cached;
      }
    }

    // Cache this MDS API
    const [year, month, day] = payload.nextUpdate.split('-');
    this.mdsCache[url] = {
      ...mds,
      // Store the header `alg` so we know what to use when verifying metadata statement hashes
      alg: header.alg,
      // Store the payload `no` to make sure we're getting the next TOC in the sequence
      no: payload.no,
      // Convert the nextUpdate property into a Date so we can determine when to re-download
      nextUpdate: new Date(
        parseInt(year, 10),
        // Months need to be zero-indexed
        parseInt(month, 10) - 1,
        parseInt(day, 10),
      ),
    };
  }

  /**
   * A helper method to pause execution until the service is ready
   */
  private async pauseUntilReady(): Promise<void> {
    if (this.state === SERVICE_STATE.READY) {
      return;
    }

    // State isn't ready, so set up polling
    const readyPromise = new Promise<void>((resolve, reject) => {
      const totalTimeoutMS = 70000;
      const intervalMS = 100;
      let iterations = totalTimeoutMS / intervalMS;

      // Check service state every `intervalMS` milliseconds
      const intervalID: NodeJS.Timeout = setInterval(() => {
        if (iterations < 1) {
          clearInterval(intervalID);
          reject(`State did not become ready in ${totalTimeoutMS / 1000} seconds`);
        } else if (this.state === SERVICE_STATE.READY) {
          clearInterval(intervalID);
          resolve();
        }

        iterations -= 1;
      }, intervalMS);
    });

    return readyPromise;
  }
}

const metadataService = new MetadataService();

export default metadataService;

export type MetadataStatement = {
  aaguid: string;
  assertionScheme: string;
  attachmentHint: number;
  attestationRootCertificates: Base64URLString[];
  attestationTypes: number[];
  authenticationAlgorithm: number;
  authenticatorVersion: number;
  description: string;
  icon: string;
  isSecondFactorOnly: string;
  keyProtection: number;
  legalHeader: string;
  matcherProtection: number;
  protocolFamily: string;
  publicKeyAlgAndEncoding: number;
  tcDisplay: number;
  tcDisplayContentType: string;
  upv: [{ major: number; minor: number }];
  userVerificationDetails: [[{ userVerification: 1 }]];
};

type MDSJWTTOCHeader = {
  alg: string;
  typ: string;
  x5c: Base64URLString[];
};

type MDSJWTTOCPayload = {
  // YYYY-MM-DD
  nextUpdate: string;
  entries: TOCEntry[];
  no: number;
  legalHeader: string;
};

type TOCEntry = {
  url: string;
  // YYYY-MM-DD
  timeOfLastStatusChange: string;
  hash: string;
  aaid?: string;
  aaguid?: string;
  attestationCertificateKeyIdentifiers: string[];
  statusReports: {
    status: FIDO_AUTHENTICATOR_STATUS;
    certificateNumber: string;
    certificate: string;
    certificationDescriptor: string;
    url: string;
    certificationRequirementsVersion: string;
    certificationPolicyVersion: string;
    // YYYY-MM-DD
    effectiveDate: string;
  }[];
};

type TOCAAGUIDEntry = Omit<TOCEntry, 'aaid'> & {
  aaguid: string;
};
