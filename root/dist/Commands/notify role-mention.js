import { SlashCommandBuilder, PermissionFlagsBits, ComponentType, RoleSelectMenuBuilder } from 'discord.js';
import { RoleMentionsHandler } from '../Models/RoleMentionsHandler.js';
const categories = [
    { key: 'Strings', customId: 'p_185924229521215490' },
    { key: 'Experiments', customId: 'p_185924546908393474' },
    { key: 'Endpoints', customId: 'p_185929000818839554' },
    { key: 'Dismissible Contents', customId: 'p_185929129684635652' },
    { key: 'Miscellaneous', customId: 'p_185929398652768258' }
];
export default {
    data: new SlashCommandBuilder()
        .setName('notify role-mention')
        .setDescription('Manage role-mention pings for subscriptions.')
        .addStringOption(opt => opt.setName('subscription')
        .setDescription('Subscription type to configure.')
        .setRequired(true)
        .addChoices({ name: 'Previews', value: 'previews' }, { name: 'Status', value: 'status' }))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild |
        PermissionFlagsBits.ManageRoles |
        PermissionFlagsBits.MentionEveryone),
    async execute(interaction) {
        const subscription = interaction.options.getString('subscription', true);
        // Permission check
        if (!interaction.memberPermissions?.has([
            PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.MentionEveryone
        ])) {
            return interaction.reply({
                content: 'You need `Manage Server`, `Manage Roles`, and `Mention Everyone` permissions to use this command.',
                ephemeral: true
            });
        }
        // Build container components
        const headerText = subscription === 'previews'
            ? '# <:Discord_Previews:1388034202855014470> Discord Previews\nSelect roles to mention for each preview section.'
            : '# <:Discord_Staff:1303532855888183306> Discord Status\nSelect roles to mention for each incident impact.';
        const container = [
            { type: 10, content: headerText },
            { type: 14, spacing: 2 }
        ];
        for (const { key, customId } of categories) {
            container.push({ type: 10, content: `## ${key}` });
            const select = new RoleSelectMenuBuilder()
                .setCustomId(`${subscription}_${customId}`)
                .setPlaceholder(`Select role for ${key}`)
                .setMaxValues(1);
            container.push({ type: 1, components: [select.toJSON()] });
            container.push({ type: 14 });
        }
        await interaction.reply({ components: [{ type: 17, components: container }], ephemeral: true, fetchReply: true });
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.RoleSelect,
            time: 120000,
            filter: i => i.user.id === interaction.user.id
        });
        collector.on('collect', async (select) => {
            const [, customId] = select.customId.split('_');
            const category = categories.find(c => c.customId === customId)?.key;
            if (!category) {
                return select.reply({ content: 'Unknown category.', ephemeral: true });
            }
            const role = select.roles.first();
            if (!role) {
                return select.reply({ content: 'No role selected.', ephemeral: true });
            }
            // Upsert mapping
            const existing = await RoleMentionsHandler.findOne({
                guildId: interaction.guildId,
                type: subscription,
                value: category
            });
            if (existing && existing.roleId === role.id) {
                await RoleMentionsHandler.deleteOne({ _id: existing._id });
                return select.reply({ content: `${role} removed from **${category}** mentions.`, ephemeral: true });
            }
            await RoleMentionsHandler.findOneAndUpdate({ guildId: interaction.guildId, type: subscription, value: category }, { roleId: role.id }, { upsert: true });
            return select.reply({ content: `${role} will now be mentioned for **${category}**.`, ephemeral: true });
        });
        collector.on('end', collected => {
            if (collected.size === 0) {
                interaction.editReply({ content: 'No selections made.', components: [] });
            }
        });
    }
};
