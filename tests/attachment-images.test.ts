import { prepareAttachmentImage, MAX_NATIVE_IMAGE_BYTES } from '../src/utils/attachment-image';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=';
const WEBP = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==';
const attachment = { id: 456, ticketID: 123, ticketNoteID: 789, fileName: 'fixture.png', contentType: 'image/png', data: PNG };
const childDetail = (row: Record<string, unknown>) => ({
  items: [row],
  pageDetails: { count: 1, requestCount: 1, prevPageUrl: null, nextPageUrl: null },
});
const config: McpServerConfig = { name: 'image-test', version: '0', autotask: {
  username: 'synthetic', secret: 'synthetic', integrationCode: 'synthetic', apiUrl: 'https://images.invalid/atservicesrest/',
} };
const logger = new Logger('error');

describe('bounded native images', () => {
  test('PNG content is removed from metadata and returned as a native image', () => {
    const result = prepareAttachmentImage(attachment, 123);
    expect(result.image).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' });
    expect(result.metadata).not.toHaveProperty('data');
    expect(result.metadata.imageContent).toEqual({ mimeType: 'image/png', bytes: Buffer.from(PNG, 'base64').length, width: 1, height: 1 });
  });
  test('WebP signature and dimensions are accepted', () => {
    expect(prepareAttachmentImage({ ...attachment, fileName: 'fixture.webp', contentType: 'image/webp', data: WEBP }, 123).image?.mimeType).toBe('image/webp');
  });
  test('JPEG dimensions are accepted from a real one-pixel fixture', () => {
    const result = prepareAttachmentImage({ ...attachment, fileName: 'fixture.jpg', contentType: 'image/jpeg', data: JPEG }, 123);
    expect(result.image?.mimeType).toBe('image/jpeg');
    expect(result.metadata.imageContent).toMatchObject({ width: 1, height: 1 });
  });
  test.each([
    ['image/jpeg', Buffer.from([255, 216, 255, 255, 255, 255, 255, 255, 255, 255, 255, 217])],
    ['image/webp', Buffer.from(WEBP, 'base64').subarray(0, 20)],
  ])('truncated %s is rejected without a buffer bounds exception', (contentType, bytes) => {
    expect(() => prepareAttachmentImage({ ...attachment, contentType, data: (bytes as Buffer).toString('base64') }, 123)).toThrow('format header');
  });
  test('absent or generic MIME still detects image bytes', () => {
    for (const contentType of [undefined, 'application/octet-stream']) {
      expect(prepareAttachmentImage({ ...attachment, contentType }, 123).image?.mimeType).toBe('image/png');
    }
  });
  test('metadata and non-image file response contracts remain intact', () => {
    const { data: _data, ...metadata } = attachment;
    expect(prepareAttachmentImage(metadata, undefined)).toEqual({ metadata });
    const pdf = { ...attachment, contentType: 'application/pdf', fileName: 'fixture.pdf', data: 'JVBERi0xLjQ=' };
    expect(prepareAttachmentImage(pdf, undefined)).toEqual({ metadata: pdf });
  });
  test.each([undefined, 0, -1, '123', 124])('missing, invalid or mismatched parent ticket %j fails closed', ticketId => {
    expect(() => prepareAttachmentImage(attachment, ticketId)).toThrow(/ticket|ownership/);
  });
  test.each([undefined, '123', 124])('unverified returned parent %j fails closed', ticketID => {
    expect(() => prepareAttachmentImage({ ...attachment, ticketID }, 123)).toThrow('ownership');
  });
  test.each(['image/svg+xml', 'image/gif', 'image/avif'])('unsupported declared type %s is rejected', contentType => {
    expect(() => prepareAttachmentImage({ ...attachment, contentType, data: Buffer.from('<svg/>').toString('base64') }, 123)).toThrow('Only PNG');
  });
  test('signature/MIME mismatch never falls back to text base64', () => {
    expect(() => prepareAttachmentImage({ ...attachment, contentType: 'image/jpeg' }, 123)).toThrow('MIME');
  });
  test.each(['GIF89a', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'BMfixture'])('unsupported image signatures %s cannot use the generic file fallback', bytes => {
    expect(() => prepareAttachmentImage({ ...attachment, contentType: 'application/octet-stream', fileName: 'attachment', data: Buffer.from(bytes).toString('base64') }, 123)).toThrow('Only PNG');
  });
  test.each([PNG + '\n', PNG.slice(0, -1), PNG.slice(0, -2) + '$=', PNG.slice(0, -2) + 'J='])('invalid base64 is rejected', data => {
    expect(() => prepareAttachmentImage({ ...attachment, data }, 123)).toThrow(/base64|invalid/);
  });
  test('raw byte limit is fixed regardless of the caller service cap', () => {
    const oversized = Buffer.alloc(MAX_NATIVE_IMAGE_BYTES + 1);
    Buffer.from(PNG, 'base64').copy(oversized);
    expect(() => prepareAttachmentImage({ ...attachment, data: oversized.toString('base64') }, 123)).toThrow('512 KiB');
  });
  test.each([[0, 1], [8193, 1], [8192, 8192]])('dimensions %j are bounded before pixel decoding', (width, height) => {
    const bytes = Buffer.from(PNG, 'base64');
    bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    expect(() => prepareAttachmentImage({ ...attachment, data: bytes.toString('base64') }, 123)).toThrow('dimensions');
  });
  test('truncated PNG and overflowing chunks return a controlled error', () => {
    const bytes = Buffer.from(PNG, 'base64');
    bytes.writeUInt32BE(0xffffffff, 33);
    for (const data of [PNG.slice(0, 32), bytes.toString('base64')]) {
      expect(() => prepareAttachmentImage({ ...attachment, data }, 123)).toThrow('format header');
    }
  });
  test('animated PNG is rejected', () => {
    const bytes = Buffer.from(PNG, 'base64');
    bytes.write('acTL', 37, 'ascii');
    expect(() => prepareAttachmentImage({ ...attachment, data: bytes.toString('base64') }, 123)).toThrow('Animated');
  });
});

describe('attachment service and MCP tool ownership', () => {
  let service: AutotaskService;
  let handler: AutotaskToolHandler;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  beforeEach(() => {
    service = new AutotaskService(config, logger);
    handler = new AutotaskToolHandler(service, logger, true);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (!String(url).startsWith('https://images.invalid/')) throw new Error('Unexpected outbound request');
      return new Response(JSON.stringify(childDetail(attachment)));
    });
  });
  afterEach(() => jest.restoreAllMocks());
  test.each(['autotask_get_ticket_attachment', 'autotask_get_ticket_note_attachment'])('%s returns a native block with no base64 in metadata', async name => {
    const result = await handler.callTool(name, { ticketId: 123, ticketNoteId: 789, attachmentId: 456, includeData: true });
    expect(result.isError).not.toBe(true);
    expect(result.content[1]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' });
    expect(result.content[0].text).not.toContain(PNG);
    expect(JSON.parse(result.content[0].text).data).not.toHaveProperty('data');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(name === 'autotask_get_ticket_attachment'
      ? 'https://images.invalid/atservicesrest/v1.0/TicketAttachments/456'
      : 'https://images.invalid/atservicesrest/v1.0/TicketNotes/789/Attachments/456');
  });
  test('live-shaped one-row JPEG response becomes a native image', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(childDetail({ ...attachment, parentID: 123, ticketNoteID: null, fullPath: 'fixture.jpg', contentType: 'image/jpeg', data: JPEG }))));
    const result = await handler.callTool('autotask_get_ticket_attachment', { ticketId: 123, attachmentId: 456, includeData: true });
    expect(result.isError).not.toBe(true);
    expect(result.content[1]).toEqual({ type: 'image', data: JPEG, mimeType: 'image/jpeg' });
    expect(result.content[0].text).not.toContain(JPEG);
  });
  test('ticket-note image requires parent ticketId', async () => {
    const result = await handler.callTool('autotask_get_ticket_note_attachment', { ticketNoteId: 789, attachmentId: 456, includeData: true });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).not.toContain(PNG);
  });
  test.each([{ ticketID: undefined }, { ticketID: '123' }, { ticketID: 124 }, { parentID: 999, ticketNoteID: null }, { id: 999 }])('ticket attachment rejects unverified ownership: %j', async fields => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(childDetail({ ...attachment, ...fields }))));
    expect(await service.getTicketAttachment(123, 456, { includeData: true })).toBeNull();
  });
  test.each([{ ticketNoteID: undefined }, { ticketNoteID: '789' }, { ticketNoteID: 790 }, { ticketID: undefined }, { ticketID: 124 }, { parentID: 999 }, { id: 999 }])('note attachment rejects unverified ownership: %j', async fields => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(childDetail({ ...attachment, ...fields }))));
    expect(await service.getTicketNoteAttachment(789, 456, { ticketId: 123, includeData: true })).toBeNull();
  });
  test.each(['autotask_get_ticket_attachment', 'autotask_get_ticket_note_attachment'])('%s metadata path strips bytes inside child items', async name => {
    const result = await handler.callTool(name, { ticketId: 123, ticketNoteId: 789, attachmentId: 456 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).not.toContain(PNG);
    expect(JSON.parse(result.content[0].text).data).not.toHaveProperty('data');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/(Tickets\/123|TicketNotes\/789)\/Attachments\/456$/);
  });
  test.each([
    { items: [], pageDetails: { count: 0 } },
    { items: [attachment, attachment], pageDetails: { count: 2 } },
    { items: [attachment], pageDetails: { count: 2 } },
    { items: [attachment], pageDetails: { count: 1, requestCount: 2 } },
    { items: [attachment], pageDetails: { count: 1, nextPageUrl: '/next' } },
    { items: [attachment], item: attachment },
    { item: attachment, pageDetails: { count: 1 } },
  ])('ambiguous child response fails closed without image content: %j', async response => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(response)));
    const result = await handler.callTool('autotask_get_ticket_attachment', { ticketId: 123, attachmentId: 456, includeData: true });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).not.toContain(PNG);
  });
  test('non-image attachments retain the base64 response contract', async () => {
    const data = 'JVBERi0xLjQ=';
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(childDetail({ ...attachment, contentType: 'application/pdf', fileName: 'fixture.pdf', data }))));
    const result = await handler.callTool('autotask_get_ticket_attachment', { ticketId: 123, attachmentId: 456, includeData: true });
    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain(data);
  });
  test('maxInlineBase64Bytes cannot raise the native image limit', async () => {
    const bytes = Buffer.alloc(MAX_NATIVE_IMAGE_BYTES + 1); Buffer.from(PNG, 'base64').copy(bytes);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(childDetail({ ...attachment, data: bytes.toString('base64') }))));
    const result = await handler.callTool('autotask_get_ticket_attachment', { ticketId: 123, attachmentId: 456, includeData: true, maxInlineBase64Bytes: 3000000 });
    expect(result.isError).toBe(true); expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('512 KiB');
  });
  test('invalid route identifiers are rejected before download', async () => {
    await expect(service.getTicketAttachment(123, 0, { includeData: true })).rejects.toThrow('positive');
    await expect(service.getTicketNoteAttachment(789, 456, { ticketId: 0, includeData: true })).rejects.toThrow('positive');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
