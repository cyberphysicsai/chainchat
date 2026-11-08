/** Exact native delivery projection. This module never grants file custody. */
import { createHash } from 'node:crypto';
const fail = () => Object.assign(new Error('The outgoing native payload does not match reviewed content and owned media.'), {code:'NATIVE_OUTPUT_MEDIA_HELD'});
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hash = value => createHash('sha256').update(value,'utf8').digest('hex');
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\0\r\n]/u.test(value);
const fields = new Set(['text','mediaUrl','mediaUrls','audioAsVoice','replyToId','replyToTag','replyToCurrent']);

function reduced(payload) {
  if (!plain(payload) || Object.keys(payload).some(key => !fields.has(key) && payload[key] !== undefined) ||
      payload.text !== undefined && typeof payload.text !== 'string' ||
      payload.mediaUrls !== undefined && (!Array.isArray(payload.mediaUrls) || payload.mediaUrls.length > 10 ||
        Object.keys(payload.mediaUrls).length !== payload.mediaUrls.length || payload.mediaUrls.some(item => !reference(item))) ||
      payload.mediaUrl !== undefined && !reference(payload.mediaUrl) ||
      ['audioAsVoice','replyToTag','replyToCurrent'].some(key => payload[key] !== undefined && typeof payload[key] !== 'boolean') ||
      payload.replyToId !== undefined && !reference(payload.replyToId)) throw fail();
  return {text:payload.text ?? '', references:[...new Set([...(payload.mediaUrls || []),...(payload.mediaUrl ? [payload.mediaUrl] : [])])],
    audioAsVoice:payload.audioAsVoice === true, replyToId:payload.replyToId, replyToTag:payload.replyToTag === true, replyToCurrent:payload.replyToCurrent === true};
}

/** normalize must be the pinned upstream PUBLIC outbound SDK, supplied privately. */
export async function authorizeNativeOutputDelivery({candidate,payload,deliveries,normalize}) {
  if (typeof candidate !== 'string' || !candidate.trim() || Buffer.byteLength(candidate) > 2*1024*1024 ||
      !Array.isArray(deliveries) || deliveries.length > 10 || typeof normalize !== 'function') throw fail();
  const projected = await normalize(candidate);
  if (!Array.isArray(projected) || projected.length !== 1) throw fail();
  const expected = reduced(projected[0]), actual = reduced(payload);
  if (actual.text !== expected.text || actual.audioAsVoice !== expected.audioAsVoice || actual.replyToId !== expected.replyToId ||
      actual.replyToTag !== expected.replyToTag || actual.replyToCurrent !== expected.replyToCurrent) throw fail();
  const byReference = new Map();
  for (const row of deliveries) {
    if (!plain(row) || !reference(row.original) || !reference(row.ownedFile) || !/^[a-f0-9]{64}$/u.test(row.sha256 || '') ||
        !/^[a-f0-9]{64}$/u.test(row.assetId || '')) throw fail();
    for (const value of new Set([row.original,row.ownedFile])) {
      if (byReference.has(value) && byReference.get(value) !== row.ownedFile) throw fail();
      byReference.set(value,row.ownedFile);
    }
  }
  const map = values => values.map(value => {if (!byReference.has(value)) throw fail();return byReference.get(value);});
  const mediaUrls = map(actual.references), expectedUrls = map(expected.references);
  if (JSON.stringify(mediaUrls) !== JSON.stringify(expectedUrls)) throw fail();
  return {text:actual.text, ...(mediaUrls.length ? {mediaUrls,mediaUrl:mediaUrls[0]} : {}),
    ...(actual.audioAsVoice ? {audioAsVoice:true} : {}), ...(actual.replyToId !== undefined ? {replyToId:actual.replyToId} : {}),
    ...(actual.replyToTag ? {replyToTag:true} : {}), ...(actual.replyToCurrent ? {replyToCurrent:true} : {})};
}

/** The private plugin accepts only an exact, current broker rewrite for its raw receipt. */
export function validateNativeOutputPermit(response,{candidateSha256,outputAssetsSha256}) {
  if (!response || response.allowed !== true || response.purpose !== 'candidate' ||
      response.candidateSha256 !== candidateSha256 || response.outputAssetsSha256 !== outputAssetsSha256 ||
      !/^[a-f0-9]{64}$/u.test(candidateSha256 || '') || !/^[a-f0-9]{64}$/u.test(outputAssetsSha256 || '')) throw fail();
  reduced(response.delivery);
  return structuredClone(response.delivery);
}

export const nativeCandidateHash = hash;
