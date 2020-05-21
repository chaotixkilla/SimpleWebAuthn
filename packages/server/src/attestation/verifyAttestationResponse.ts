import decodeAttestationObject from '@helpers/decodeAttestationObject';
import decodeClientDataJSON from '@helpers/decodeClientDataJSON';
import { ATTESTATION_FORMATS, AuthenticatorAttestationResponseJSON, VerifiedAttestation } from '@webauthntine/typescript-types';

import verifyFIDOU2F from './verifications/verifyFIDOU2F';
import verifyPacked from './verifications/verifyPacked';
import verifyNone from './verifications/verifyNone';
import verifyAndroidSafetynet from './verifications/verifyAndroidSafetyNet';

/**
 * Verify that the user has legitimately completed the registration process
 *
 * @param response Authenticator attestation response with base64-encoded values
 * @param expectedOrigin Expected URL of website attestation should have occurred on
 */
export default function verifyAttestationResponse(
  response: AuthenticatorAttestationResponseJSON,
  expectedOrigin: string,
): VerifiedAttestation {
  const { base64AttestationObject, base64ClientDataJSON } = response;
  const attestationObject = decodeAttestationObject(base64AttestationObject);
  const clientDataJSON = decodeClientDataJSON(base64ClientDataJSON);

  console.debug('decoded attestationObject:', attestationObject);
  console.debug('decoded clientDataJSON:', clientDataJSON);

  const { type, origin } = clientDataJSON;

  // Check that the origin is our site
  if (origin !== expectedOrigin) {
    console.error('client origin did not equal our origin');
    console.debug('Expected Origin:', expectedOrigin);
    console.debug('attestation\'s origin:', origin);
    throw new Error('Attestation origin was an unexpected value');
  }

  // Make sure we're handling an attestation
  if (type !== 'webauthn.create') {
    console.error('type did not equal "webauthn.create"');
    console.debug('attestation\'s type:', type);
    throw new Error('Attestation type was an unexpected value');
  }

  const { fmt } = attestationObject;

  /**
   * Verification can only be performed when attestation = 'direct'
   */
  if (fmt === ATTESTATION_FORMATS.FIDO_U2F) {
    console.log('Decoding FIDO-U2F attestation');
    return verifyFIDOU2F(attestationObject, base64ClientDataJSON);
  }

  if (fmt === ATTESTATION_FORMATS.PACKED) {
    console.log('Decoding Packed attestation');
    return verifyPacked(attestationObject, base64ClientDataJSON);
  }

  if (fmt === ATTESTATION_FORMATS.ANDROID_SAFETYNET) {
    console.log('Decoding Android Safetynet attestation');
    return verifyAndroidSafetynet(attestationObject, base64ClientDataJSON);
  }

  if (fmt === ATTESTATION_FORMATS.NONE) {
    console.log('Decoding None attestation');
    return verifyNone(attestationObject);
  }

  const reason = `Unsupported Attestation Format: ${fmt}`;
  console.error(reason);
  throw new Error(reason);
}
