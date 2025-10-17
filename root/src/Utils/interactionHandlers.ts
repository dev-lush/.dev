import { ButtonInteraction, AttachmentBuilder, MessageFlags } from 'discord.js';
import fetch from 'node-fetch';
import {
    assetSuccessMessage,
    assetTooLargeMessage,
    genericErrorMessage,
    assetNotFoundMessage,
    serverNotFoundMessage,
    assetFetchFailedMessage
} from '../System Messages/Commands/info/server.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export async function handleAssetButton(interaction: ButtonInteraction): Promise<void> {
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const [_, assetType, guildId] = interaction.customId.split(':');
        if (!assetType || !guildId) {
            const payload = genericErrorMessage();
            await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
            return;
        }

        const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            const payload = serverNotFoundMessage();
            await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
            return;
        }

        let assetUrl: string | null = null;
        switch (assetType) {
            case 'icon':
                assetUrl = guild.iconURL({ size: 4096, forceStatic: false });
                break;
            case 'banner':
                assetUrl = guild.bannerURL({ size: 4096, forceStatic: false });
                break;
            case 'splash':
                assetUrl = guild.splashURL({ size: 4096, forceStatic: false });
                break;
        }

        if (!assetUrl) {
            const payload = assetNotFoundMessage();
            await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
            return;
        }

        const response = await fetch(assetUrl);
        if (!response.ok) {
            const payload = assetFetchFailedMessage();
            await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
            return;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const extension = assetUrl.split('.').pop()?.split('?')[0] ?? 'png';
        const fileName = `${assetType}-${guild.id}.${extension}`;

        if (buffer.length > MAX_FILE_SIZE) {
            const payload = assetTooLargeMessage(assetUrl);
            await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
            return;
        }

        const attachment = new AttachmentBuilder(buffer, { name: fileName });
        const payload = assetSuccessMessage(attachment, assetUrl);
        await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

    } catch (error) {
        console.error('Failed to handle asset button:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An unexpected error occurred.', flags: MessageFlags.Ephemeral });
        } else if (!interaction.replied) {
            const payload = genericErrorMessage();
            await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
        }
    }
}
