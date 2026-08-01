const manifest = {
    name: 'Google Takeout Import',
    slug: 'google-takeout-import',
    version: '0.1.2',
    description: 'Import data from Google Takeout .zip files.',
    settings: [
        {
            slug: 'google-takeout',
            component: 'settings/takeout',
            label: 'Import from Google',
        },
    ],
    repository: { url: 'https://github.com/tinycld/google-takeout-import' },
    peerVersions: { '@tinycld/core': '>=0.0.4 <0.1.0' },
}

export default manifest
