import assert from 'node:assert/strict';
import test from 'node:test';
import { createClassroomServer } from './server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('MCP only publishes read tools and requests my submissions', async () => {
  const server = createClassroomServer(async url => {
    assert.equal(url.pathname, '/v1/courses/course-1/courseWork/-/studentSubmissions');
    assert.equal(url.searchParams.get('userId'), 'me');
    assert.equal(url.searchParams.get('pageToken'), 'next');
    return Response.json({ studentSubmissions: [{ id: 'sub-1' }] });
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
    const result = await client.callTool({
      name: 'list_my_submissions',
      arguments: { courseId: 'course-1', pageToken: 'next' },
    });
    assert.deepEqual(JSON.parse(result.content[0].text), { studentSubmissions: [{ id: 'sub-1' }] });
  } finally {
    await client.close();
    await server.close();
  }
});

test('a Google Doc exports its content to a local file', async () => {
  const { readFile, rm } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const server = createClassroomServer(async url => {
    if (url.pathname.endsWith('/export')) {
      assert.equal(url.pathname, '/drive/v3/files/doc-1/export');
      assert.equal(url.searchParams.get('mimeType'), 'text/plain');
      return new Response('Worksheet text');
    }
    assert.equal(url.pathname, '/drive/v3/files/doc-1');
    return Response.json({
      name: 'Worksheet: lesson 1',
      mimeType: 'application/vnd.google-apps.document',
      capabilities: { canDownload: true },
    });
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let localPath;
  try {
    const result = await client.callTool({ name: 'download_drive_file', arguments: { fileId: 'doc-1' } });
    assert.equal(result.isError, undefined, result.content[0].text);
    ({ localPath } = JSON.parse(result.content[0].text));
    assert.ok(localPath.endsWith('attachment-Worksheet_ lesson 1.txt'));
    assert.equal(await readFile(localPath, 'utf8'), 'Worksheet text');
  } finally {
    if (localPath) {
      await rm(localPath);
      await (await import('node:fs/promises')).rmdir(dirname(localPath));
    }
    await client.close();
    await server.close();
  }
});

test('assignment pages preserve the token needed to reach later work', async () => {
  const server = createClassroomServer(async url => {
    assert.equal(url.pathname, '/v1/courses/course-1/courseWork');
    if (url.searchParams.get('pageToken') === 'page-2') {
      return Response.json({ courseWork: [{ id: 'assignment-2' }] });
    }
    return Response.json({ courseWork: [{ id: 'assignment-1' }], nextPageToken: 'page-2' });
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const first = await client.callTool({ name: 'list_assignments', arguments: { courseId: 'course-1', pageSize: 1 } });
    const page = JSON.parse(first.content[0].text);
    const second = await client.callTool({
      name: 'list_assignments',
      arguments: { courseId: 'course-1', pageSize: 1, pageToken: page.nextPageToken },
    });
    assert.deepEqual(JSON.parse(second.content[0].text), { courseWork: [{ id: 'assignment-2' }] });
  } finally {
    await client.close();
    await server.close();
  }
});
