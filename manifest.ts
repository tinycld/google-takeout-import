const manifest = {
    name: 'Google Takeout Import',
    slug: 'google-takeout-import',
    version: '0.3.8',
    description: 'Import data from Google Takeout .zip files.',
    accountSettings: [
        {
            slug: 'google-takeout',
            component: 'settings/takeout',
            label: 'Import from Google',
        },
    ],
    help: { directory: 'help' },
    repository: { url: 'https://github.com/tinycld/google-takeout-import' },
    peerVersions: { '@tinycld/core': '>=0.12.0 <0.13.0' },
}

export default manifest
