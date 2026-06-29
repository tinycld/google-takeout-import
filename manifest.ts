const manifest = {
    name: 'Google Takeout Import',
    slug: 'google-takeout-import',
    version: '0.1.1',
    description: 'Import data from Google Takeout .zip files.',
    settings: [
        {
            slug: 'google-takeout',
            component: 'settings/takeout',
            label: 'Import from Google',
        },
    ],
    repository: { url: 'https://github.com/tinycld/google-takeout-import' },
}

export default manifest
