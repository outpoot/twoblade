import { error } from '@sveltejs/kit';
import { isPublicHost } from '$lib/server/ssrf';
import type { RequestHandler } from './$types';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 50 * 1024 * 1024;

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }

  const mediaUrl = url.searchParams.get('url');

  if (!mediaUrl) {
    throw error(400, 'Missing URL parameter');
  }

  try {
    let target: URL;
    try {
      target = new URL(mediaUrl);
    } catch {
      throw error(400, 'Invalid URL');
    }

    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!['http:', 'https:'].includes(target.protocol) || !(await isPublicHost(target.hostname))) {
        throw error(400, 'URL not allowed');
      }
      response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        target = new URL(response.headers.get('location')!, target);
        response = null;
        continue;
      }
      break;
    }
    if (!response) {
      throw error(400, 'Too many redirects');
    }

    if (!response.ok) {
      throw error(response.status, 'Failed to fetch media');
    }

    const contentType = response.headers.get('content-type');
    if (!contentType?.startsWith('image/') && !contentType?.startsWith('video/')) {
      throw error(400, 'URL does not point to an image or video');
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) {
      throw error(413, 'Media too large');
    }

    const mediaType = contentType.startsWith('image/') ? 'image' : 'video';
    const extension = contentType.substring(contentType.indexOf('/') + 1).split(';')[0].replace(/[^a-z0-9.+-]/gi, '');

    const headers: Record<string, string> = {
      'Content-Type': contentType!,
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `attachment; filename="${mediaType}.${extension}"`
    };

    return new Response(response.body, { headers });
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e) throw e;
    console.error('Proxy error:', e);
    throw error(500, 'Failed to proxy media');
  }
};
