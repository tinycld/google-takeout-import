const manifest = {
    name: 'Google Takeout Import',
    slug: 'google-takeout-import',
    version: '0.2.1',
    description: 'Import data from Google Takeout .zip files.',
    settings: [
        {
            slug: 'google-takeout',
            component: 'settings/takeout',
            label: 'Import from Google',
        },
    ],
    help: { directory: 'help' },
    repository: { url: 'https://github.com/tinycld/google-takeout-import' },
    peerVersions: { '@tinycld/core': '>=0.5.1 <0.6.0' },
}

export default manifest
