export const MAX_NATIVE_IMAGE_BYTES = 512 * 1024;
export const MAX_NATIVE_IMAGE_BASE64 = Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_EDGE = 8192;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

export interface NativeImageContent {
  type: 'image';
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

function imageType(bytes: Buffer): NativeImageContent['mimeType'] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function unsupportedImageSignature(bytes: Buffer): boolean {
  const prefix = bytes.toString('ascii');
  return /^GIF8[79]a/.test(prefix) || prefix.startsWith('BM') || prefix.startsWith('II*\0') || prefix.startsWith('MM\0*') ||
    /<svg\b/i.test(prefix.trimStart()) || (bytes.length >= 4 && bytes.readUInt32LE(0) === 65536) ||
    (prefix.slice(4, 8) === 'ftyp' && /avif|avis|heic|heix|hevc|hevx|mif1/.test(prefix.slice(8)));
}

function malformed(): never {
  throw new Error('Attachment image has an invalid or truncated format header.');
}

// Inspect bounded format headers without decompressing untrusted pixels.
function dimensions(bytes: Buffer, mimeType: NativeImageContent['mimeType']): { width: number; height: number } {
  if (mimeType === 'image/png') {
    if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') malformed();
    let offset = 8;
    let hasPixels = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) malformed();
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('Animated image attachments are not supported.');
      if (type === 'IHDR' && offset !== 8) malformed();
      if (type === 'IDAT') hasPixels = true;
      if (type === 'IEND' && (length !== 0 || offset + 12 !== bytes.length)) malformed();
      offset += 12 + length;
    }
    if (offset !== bytes.length || !hasPixels) malformed();
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') {
    if (bytes.length < 12 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) malformed();
    let offset = 2;
    while (offset + 4 <= bytes.length - 2) {
      if (bytes[offset] !== 255) malformed();
      while (bytes[offset + 1] === 255) offset++;
      if (offset + 4 > bytes.length - 2) malformed();
      const marker = bytes[offset + 1];
      if (marker === 218 || marker === 217) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length - 2) malformed();
      if ([192, 193, 194].includes(marker)) {
        if (length < 8 || bytes[offset + 4] !== 8) malformed();
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    return malformed();
  }
  if (bytes.length < 25 || bytes.readUInt32LE(4) + 8 !== bytes.length) malformed();
  let canvas: { width: number; height: number } | undefined;
  let frame: { width: number; height: number } | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + length + (length % 2) > bytes.length) malformed();
    if (type === 'ANIM' || type === 'ANMF') throw new Error('Animated image attachments are not supported.');
    if (type === 'VP8X') {
      if (canvas) malformed();
      if (length < 10 || (bytes[dataOffset] & 2) !== 0) throw new Error('Animated or malformed WebP attachment is not supported.');
      canvas = { width: bytes.readUIntLE(dataOffset + 4, 3) + 1, height: bytes.readUIntLE(dataOffset + 7, 3) + 1 };
    } else if (type === 'VP8 ') {
      if (frame) malformed();
      if (length < 10 || (bytes[dataOffset] & 1) !== 0 || !bytes.subarray(dataOffset + 3, dataOffset + 6).equals(Buffer.from([157, 1, 42]))) malformed();
      frame = { width: bytes.readUInt16LE(dataOffset + 6) & 16383, height: bytes.readUInt16LE(dataOffset + 8) & 16383 };
    } else if (type === 'VP8L') {
      if (frame) malformed();
      if (length < 5 || bytes[dataOffset] !== 47) malformed();
      const packed = bytes.readUInt32LE(dataOffset + 1);
      if ((packed >>> 29) !== 0) malformed();
      frame = { width: (packed & 16383) + 1, height: ((packed >>> 14) & 16383) + 1 };
    }
    offset = dataOffset + length + (length % 2);
  }
  if (offset !== bytes.length || !frame || (canvas && (canvas.width !== frame.width || canvas.height !== frame.height))) malformed();
  return frame;
}

export function prepareAttachmentImage(
  attachment: Record<string, any>,
  ticketId: unknown,
): { metadata: Record<string, any>; image?: NativeImageContent } {
  const data = attachment.data;
  if (data === undefined) return { metadata: attachment }; // Metadata-only or service-level omission.
  const declaredType = typeof attachment.contentType === 'string'
    ? attachment.contentType.split(';')[0].trim().toLowerCase() : '';
  const name = attachment.fileName ?? attachment.fullPath ?? attachment.title ?? '';
  // A small prefix is enough to identify raster bytes even when MIME is absent.
  const prefix = typeof data === 'string' ? Buffer.from(data.slice(0, 48), 'base64') : Buffer.alloc(0);
  const sniffedType = imageType(prefix);
  const claimsImage = declaredType.startsWith('image/') ||
    unsupportedImageSignature(prefix) ||
    (typeof name === 'string' && /\.(?:png|jpe?g|webp|gif|svg|bmp|tiff?|avif|heic|ico)$/i.test(name));
  if (!claimsImage && !sniffedType) return { metadata: attachment }; // Existing non-image download contract.
  if (typeof ticketId !== 'number' || !Number.isSafeInteger(ticketId) || ticketId <= 0) {
    throw new Error('A parent ticketId is required to return attachment image content.');
  }
  if (attachment.ticketID !== ticketId) throw new Error('Attachment image parent-ticket ownership could not be verified.');
  if (!sniffedType) throw new Error('Only PNG, JPEG and non-animated WebP image attachments are supported.');
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== sniffedType) {
    throw new Error('Attachment image MIME type does not match its file signature.');
  }
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_NATIVE_IMAGE_BASE64) {
    throw new Error('Attachment image exceeds the fixed 512 KiB native image limit.');
  }
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Attachment image is not valid canonical base64.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_NATIVE_IMAGE_BYTES || bytes.toString('base64') !== data) throw new Error('Attachment image is invalid or exceeds the fixed 512 KiB native image limit.');
  const size = dimensions(bytes, sniffedType);
  if (size.width < 1 || size.height < 1 || size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE ||
      size.width * size.height > MAX_IMAGE_PIXELS) throw new Error('Attachment image dimensions exceed the supported limits (8192 per edge, 16 megapixels).');
  const { data: _data, ...metadata } = attachment;
  return {
    metadata: { ...metadata, imageContent: { mimeType: sniffedType, bytes: bytes.length, ...size } },
    image: { type: 'image', data, mimeType: sniffedType },
  };
}
