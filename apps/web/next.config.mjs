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
          // Content Security Policy in production builds ('unsafe-inline' scripts are needed by Next.js
          // without nonces: listed as a known gap in SECURITY.md)
          ...(process.env.NODE_ENV === 'production'
            ? [
                {
                  key: 'Content-Security-Policy',
                  value: [
                    "default-src 'self'",
                    "script-src 'self' 'unsafe-inline'",
                    "style-src 'self' 'unsafe-inline'",
                    "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
                    "connect-src 'self'",
                    "font-src 'self'",
                    "frame-ancestors 'none'",
                    "base-uri 'self'",
                    "form-action 'self'",
                  ].join('; '),
                },
                { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
              ]
            : []),
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
};
