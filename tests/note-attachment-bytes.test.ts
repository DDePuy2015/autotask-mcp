import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';

const config = { name: 'note-bytes', version: '0', autotask: {
  username: 'note-bytes-test', secret: 'synthetic', integrationCode: 'synthetic',
  apiUrl: 'https://note-bytes.invalid/ATServicesRest/',
} };
const logger = new Logger('error');
const base = 'https://note-bytes.invalid/ATServicesRest/v1.0';
const childUrl = `${base}/TicketNotes/789/Attachments/456`;
const topUrl = `${base}/TicketNoteAttachments/456`;
const bytes = Buffer.from('uploaded file').toString('base64');
const row = { id: 456, ticketNoteID: 789, ticketID: 123, title: 'fixture.pdf', contentType: 'application/pdf' };
const response = (item: unknown) => new Response(JSON.stringify({ items: [item], pageDetails: { count: 1, nextPageUrl: null } }));
const service = () => new AutotaskService(config, logger);
const options = { ticketId: 123, includeData: true };
const calls = (spy: jest.SpiedFunction<typeof fetch>) => spy.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, body: init?.body }));

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

test('verified child bytes are preferred without a top-level download', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...row, data: bytes }));
  expect((await service().getTicketNoteAttachment(789, 456, options))?.data).toBe(bytes);
  expect(calls(spy)).toEqual([{ url: childUrl, method: 'GET', body: undefined }]);
});

test('missing child bytes use only exact, owned top-level bytes', async () => {
  const spy = jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response(row))
    .mockResolvedValueOnce(response({ ...row, data: bytes }));
  expect((await service().getTicketNoteAttachment(789, 456, options))?.data).toBe(bytes);
  expect(calls(spy)).toEqual([childUrl, topUrl].map(url => ({ url, method: 'GET', body: undefined })));
});

test('child bytes with absent ownership need independent proof from the exact top-level record', async () => {
  const spy = jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response({ id: 456, title: row.title, data: bytes }))
    .mockResolvedValueOnce(response(row));
  expect(await service().getTicketNoteAttachment(789, 456, options)).toMatchObject({ ...row, data: bytes });
  expect(spy).toHaveBeenCalledTimes(2);
});

test.each([
  { ticketNoteID: undefined }, { ticketNoteID: '789' }, { ticketNoteID: 790 },
  { ticketID: undefined }, { ticketID: '123' }, { ticketID: 124 }, { parentID: 999 }, { id: 999 },
])('top-level fallback rejects unverified or contradictory ownership %j', async fields => {
  const spy = jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response(row))
    .mockResolvedValueOnce(response({ ...row, ...fields, data: bytes }));
  await expect(service().getTicketNoteAttachment(789, 456, options)).rejects.toThrow('no independently verified file bytes');
  expect(spy).toHaveBeenCalledTimes(2);
});

test('a parent-scoped child URL and parentID cannot replace note/ticket identity', async () => {
  jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response({ id: 456, parentID: 789, data: bytes }))
    .mockResolvedValueOnce(response({ id: 456, parentID: 789, data: bytes }));
  const result = await new AutotaskToolHandler(service(), logger, true).callTool('autotask_get_ticket_note_attachment', {
    ticketNoteId: 789, attachmentId: 456, ...options,
  });
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0].text).not.toContain(bytes);
});

test.each([{ id: 999 }, { ticketNoteID: 790 }, { ticketNoteID: '789' }, { ticketID: 124 }, { parentID: 999 }])('explicit child conflict %j never falls through to top-level', async fields => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...row, ...fields, data: bytes }));
  expect(await service().getTicketNoteAttachment(789, 456, options)).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1);
});

test('child 404 never queries top-level', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
  expect(await service().getTicketNoteAttachment(789, 456, options)).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1);
});

test('ambiguous child envelope never queries top-level', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [row, row] })));
  expect(await service().getTicketNoteAttachment(789, 456, options)).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1);
});

test('existing attachment without bytes reports omission rather than not-found', async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => response(row));
  await expect(service().getTicketNoteAttachment(789, 456, options)).rejects.toThrow('both endpoints omitted file bytes');
});

test('metadata strips child bytes without a top-level call', async () => {
  const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...row, data: bytes }));
  expect(await service().getTicketNoteAttachment(789, 456, { ticketId: 123 })).toEqual(row);
  expect(spy).toHaveBeenCalledTimes(1);
});

test('fallback data remains subject to the service inline cap', async () => {
  jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response(row))
    .mockResolvedValueOnce(response({ ...row, data: bytes }));
  const result = await service().getTicketNoteAttachment(789, 456, { ...options, maxInlineBase64Bytes: 4 });
  expect(result?.data).toBeUndefined();
  expect(result?.dataOmittedReason).toContain('exceeds inline limit');
});

test('independently verified child image still returns bounded native MCP content', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1cAAAAASUVORK5CYII=';
  jest.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response({ id: 456, title: 'fixture.png', contentType: 'image/png', data: png }))
    .mockResolvedValueOnce(response(row));
  const result = await new AutotaskToolHandler(service(), logger, true).callTool('autotask_get_ticket_note_attachment', {
    ticketNoteId: 789, attachmentId: 456, ...options,
  });
  expect(result.isError).not.toBe(true);
  expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: png });
  expect(result.content[0].text).not.toContain(png);
});
