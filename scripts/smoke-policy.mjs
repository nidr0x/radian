export const isCloudflarePerimeterBlock = (response) => response.status === 403
  && response.headers.get('server')?.toLowerCase() === 'cloudflare'
  && Boolean(response.headers.get('cf-ray'));
