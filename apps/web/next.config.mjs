/* global process */
/** The browser talks to /api on the same address; Next passes it on to the API server. */
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

export default {
  reactStrictMode: true,
  // Linting runs once for the whole repository (pnpm lint)
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@freight/shared'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
};
