export function assetSuccessMessage(attachment, assetUrl) {
    const fullName = attachment.name;
    const container = {
        type: 17, // Container
        accent_color: 0x5865F2,
        components: [
            {
                type: 10, // Text
                content: '## Server Asset'
            },
            {
                type: 12, // Media Grid
                items: [{ media: { url: `attachment://${fullName}` } }]
            },
            {
                type: 13,
                file: { url: `attachment://${fullName}`, name: fullName }
            },
            {
                type: 1, // Action Row
                components: [{ type: 2, style: 5, label: 'Open in Browser', url: assetUrl }]
            }
        ]
    };
    return {
        components: [container],
        files: [attachment]
    };
}
export function assetTooLargeMessage(assetUrl) {
    return {
        components: [{
                type: 10,
                content: `<:Warning:1395719352560648274> This server asset is too large to be displayed as a preview. You can view the full-resolution image using the button below.`
            },
            {
                type: 1,
                components: [{ type: 2, style: 5, label: 'Open in Browser', url: assetUrl }]
            }]
    };
}
export function genericErrorMessage() {
    return {
        components: [{
                type: 10,
                content: '<:Cross:1425291759952593066> An error occurred while processing this action.'
            }]
    };
}
export function assetNotFoundMessage() {
    return {
        components: [{
                type: 10,
                content: '<:Cross:1425291759952593066> This asset is no longer available. It may have been removed after this message was sent.'
            }]
    };
}
export function serverNotFoundMessage() {
    return {
        components: [{
                type: 10,
                content: '<:Cross:1425291759952593066> Could not find the server this asset belongs to. It might no longer be available.'
            }]
    };
}
export function assetFetchFailedMessage() {
    return {
        components: [{
                type: 10,
                content: '<:Cross:1425291759952593066> Failed to fetch the asset from Discord\'s servers. Please try again later.'
            }]
    };
}
