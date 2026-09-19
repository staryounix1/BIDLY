/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed from TypeScript source via tsconfig paths;
  // transpile them so webpack resolves their `.js`-suffixed relative imports
  // (NodeNext style) against the matching `.ts` files.
  transpilePackages: ['@bidly/config', '@bidly/i18n', '@bidly/types', '@bidly/validation'],
  webpack: (config) => {
    // Workspace packages use NodeNext-style `.js` specifiers that actually
    // refer to `.ts` sources; teach webpack the same alias TypeScript uses.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  // The API runs as a separate service; /api is not part of these apps.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
