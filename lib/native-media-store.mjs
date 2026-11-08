import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
const TYPES = Object.freeze({'image/png':['image','png'],'image/jpeg':['image','jpg'],'image/webp':['image','webp'],'image/gif':['image','gif'],
  'audio/wav':['audio','wav'],'audio/mpeg':['audio','mp3'],'audio/ogg':['audio','ogg'],'audio/flac':['audio','flac'],'audio/mp4':['audio','m4a'],
  'video/mp4':['video','mp4'],'video/webm':['video','webm'],'application/pdf':['document','pdf'],'text/plain':['document','txt']});
const MAX_BYTES = 20 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/[\0\r\n\u2028\u2029]/.test(value);
const held = message => Object.assign(new Error(message), {code: 'NATIVE_MEDIA_INVALID', status: 422});
function matches(bytes, mime) {
  const ascii = bytes.subarray(0, 16).toString('latin1');
  if (mime === 'image/png') return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
  if (mime === 'image/webp') return ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP';
  if (mime === 'audio/wav') return ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WAVE';
  if (mime === 'audio/mpeg') return ascii.startsWith('ID3') || bytes[0] === 255 && (bytes[1] & 224) === 224;
  if (mime === 'audio/ogg') return ascii.startsWith('OggS');
  if (mime === 'audio/flac') return ascii.startsWith('fLaC');
  if (['audio/mp4','video/mp4'].includes(mime)) return ascii.slice(4,8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
  if (mime === 'application/pdf') return ascii.startsWith('%PDF-');
  if (mime === 'text/plain') {try {new TextDecoder('utf-8', {fatal: true}).decode(bytes); return !bytes.includes(0);} catch {return false;}}
  return false;
}
async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw held('An owned media file changed or traverses a link.');
  return stat;
}
export class NativeMediaStore {
  constructor(directory, {quotaBytes = 2 * 1024 * 1024 * 1024} = {}) {
    this.root = path.resolve(directory); this.quotaBytes = quotaBytes; this.queue = Promise.resolve();
  }
  async initialize() {
    await fs.mkdir(this.root, {recursive: true, mode: 0o700});
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(this.root) !== this.root) throw held('Inspect the owned media directory.');
  }
  async describe(id) {
    if (!validId(id)) throw held('Choose an owned media asset.');
    await this.initialize();
    const directory = path.join(this.root, id), stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw held('An owned media directory changed.');
    const metadataFile = path.join(directory, 'metadata.json');
    const metadataStat = await regular(metadataFile);
    if (metadataStat.size > 4096) throw held('Invalid media metadata.');
    const metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
    if (!metadata || Object.keys(metadata).sort().join(',') !== 'bytes,contentFile,fileName,id,kind,mimeType,sha256,version' || metadata.version !== 1 ||
        metadata.id !== id || metadata.sha256 !== id || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > MAX_BYTES ||
        !TYPES[metadata.mimeType] || metadata.kind !== TYPES[metadata.mimeType][0] || metadata.contentFile !== 'asset.' + TYPES[metadata.mimeType][1] ||
        typeof metadata.fileName !== 'string' || !metadata.fileName || metadata.fileName.length > 160 || /[\0\r\n\/\\\u2028\u2029]/.test(metadata.fileName)) throw held('Invalid media metadata.');
    const file = path.join(directory, metadata.contentFile), fileStat = await regular(file);
    if (fileStat.size !== metadata.bytes || await fs.realpath(file) !== file) throw held('An owned media asset changed.');
    return {metadata, file};
  }
  async read(id) {
    const {metadata, file} = await this.describe(id);
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== id || !matches(bytes, metadata.mimeType)) throw held('The media content failed verification.');
    return {metadata, bytes, file};
  }
  put({mimeType, fileName, content} = {}) {
    const operation = this.queue.then(async () => {
      if (!TYPES[mimeType] || typeof fileName !== 'string' || !fileName || fileName.length > 160 || /[\0\r\n\/\\\u2028\u2029]/.test(fileName) ||
          typeof content !== 'string' || content.length > Math.ceil(MAX_BYTES / 3) * 4) throw held('Use a supported bounded image, audio, video, PDF or UTF-8 text file.');
      const bytes = Buffer.from(content, 'base64');
      if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== content || !matches(bytes, mimeType)) throw held('The file bytes do not match the declared media type.');
      await this.initialize();
      const id = digest(bytes), directory = path.join(this.root, id);
      try {return (await this.read(id)).metadata;} catch (error) {if (error.code !== 'ENOENT') throw error;}
      const entries = await fs.readdir(this.root, {withFileTypes: true});
      let used = 0, count = 0;
      for (const entry of entries) {
        if (!validId(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink() || ++count > 4096) throw held('The media store needs local inspection.');
        const metadata = await this.describe(entry.name); used += metadata.metadata.bytes;
      }
      if (used + bytes.length > this.quotaBytes || count >= 4096) throw held('The local media storage limit was reached.');
      const temporary = path.join(this.root, '.upload-' + randomUUID());
      await fs.mkdir(temporary, {mode: 0o700});
      const metadata = {version: 1, id, sha256: id, bytes: bytes.length, mimeType, fileName, kind: TYPES[mimeType][0], contentFile: 'asset.' + TYPES[mimeType][1]};
      try {
        await fs.writeFile(path.join(temporary, metadata.contentFile), bytes, {flag: 'wx', mode: 0o600});
        await fs.writeFile(path.join(temporary, 'metadata.json'), JSON.stringify(metadata), {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, directory);
      } catch (error) {
        // Only this operation's exact staging names are removed. Never recurse
        // through a directory substituted by another local process.
        const stat = await fs.lstat(temporary).catch(() => null);
        if (stat?.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(temporary) === temporary) {
          await fs.unlink(path.join(temporary, metadata.contentFile)).catch(() => {});
          await fs.unlink(path.join(temporary, 'metadata.json')).catch(() => {});
          await fs.rmdir(temporary).catch(() => {});
        }
        throw error;
      }
      return metadata;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
}
