import { Client, NewsChannel, TextChannel, PermissionFlagsBits } from 'discord.js';
import { Subscription } from '../Models/Subscription.js';
import { RoleMentionsHandler } from '../Models/RoleMentionsHandler.js';
import { formatDiscordTimestamps } from './timestamp.js';

interface Section {
  title: string;
  content: string;
}

interface CommitCommentMessageOptions {
  sha: string;
  commentUrl: string;
  author: string;
  authorUrl: string;
  body: string;
  createdAt: string;
  roleMentions: Record<string, string>; // e.g., { Strings: '<@&123>', Experiments: '<@&456>' }
}

export function buildCommitCommentMessage(options: CommitCommentMessageOptions) {
  const { sha, commentUrl, author, authorUrl, body, createdAt, roleMentions } = options;
  const sections = parseSections(body);
  const contentComponents: any[] = [];

  contentComponents.push({
    type: 10,
    content: `# <:Discord_Previews:1388034202855014470> Discord Previews\nA brand new comment in the commit [\`${sha.slice(0, 7)}\`](${commentUrl}) has been posted in one of the commit by user [@${author}](${authorUrl}):`
  });

  contentComponents.push({ type: 14, spacing: 2 });

  for (const section of sections) {
    contentComponents.push({
      type: 10,
      content: `## ${section.title}\n\n\`\`\`diff\n${section.content}\n\`\`\``
    });
    contentComponents.push({ type: 14 });
  };

  contentComponents.push({ type: 14, spacing: 2 });

  // Optional role mention block (after all sections)
  const pingRoles = sections
    .map(s => s.title)
    .filter(title => roleMentions[title])
    .map(title => roleMentions[title]);

  if (pingRoles.length > 0) {
    contentComponents.push({
      type: 10,
      content: pingRoles.join(' ')
    });
  }

  // Link button
  contentComponents.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 5,
        label: 'github.com/Discord-Datamining/Discord-Datamining/',
        emoji: {
          id: '1387799050769928254',
          name: 'GitHub',
          animated: false
        },
        url: commentUrl,
        custom_id: 'p_185402551217164290'
      }
    ]
  });

  return {
    attachments: [],
    flags: 32768,
    components: [
      {
        type: 17,
        components: contentComponents
      }
    ]
  };
}

function parseSections(body: string): Section[] {
  const sectionRegex = /##+\s*(.+?)\n+([\s\S]*?)(?=\n##+|$)/g;
  const sections: Section[] = [];
  const knownHeaders = ['Strings', 'Experiments', 'Endpoints', 'Dismissible Contents'];

  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(body)) !== null) {
    const title = match[1].trim();
    const content = match[2].trim();
    const normalizedTitle = knownHeaders.find(h => title.toLowerCase().includes(h.toLowerCase())) || 'Miscellaneous';

    sections.push({
      title: normalizedTitle,
      content
    });
  }

  if (sections.length === 0) {
    sections.push({
      title: 'Miscellaneous',
      content: body.trim()
    });
  }

  return sections;
}

async function getRoleMentionsForGuild(guildId: string, type: 'status' | 'previews') {
  const records = await RoleMentionsHandler.find({ guildId, type });
  const roleMentions: Record<string, string> = {};
  for (const rec of records) {
    roleMentions[rec.value] = `<@&${rec.roleId}>`;
  }
  return roleMentions;
}

export async function checkNewCommitComments(client: Client) {
  const response = await fetch('https://api.github.com/repos/Discord-Datamining/Discord-Datamining/commits');
  if (!response.ok) return;
  const commits = await response.json();
  const latest = commits[0];
  if (!latest) return;

  const commitDetails = await fetch(latest.url).then(res => res.json());
  const comments: any[] = await fetch(commitDetails.comments_url).then(res => res.json());

  const subscriptions = await Subscription.find({ type: 'commit' });

  for (const subscription of subscriptions) {
    const channel = await client.channels.fetch(subscription.channelId).catch(() => null);
    if (!channel || !(channel instanceof TextChannel || channel instanceof NewsChannel)) continue;
    if (!channel.guild) continue;

    // Fetch role mentions for this guild and type "previews"
    const roleMentions = await getRoleMentionsForGuild(channel.guild.id, 'previews');

    const lastId = subscription.lastCommentId;
    // Find a new comment that hasn't been sent yet
    const newComment = comments.find(c => c.html_url !== lastId);
    if (!newComment) continue;

    const payload = buildCommitCommentMessage({
      sha: latest.sha,
      commentUrl: newComment.html_url,
      author: newComment.user.login,
      authorUrl: newComment.user.html_url,
      body: newComment.body,
      createdAt: newComment.created_at,
      roleMentions
    });

    try {
      const sent = await channel.send(payload);
      if (subscription.autoPublish && channel instanceof NewsChannel && channel.permissionsFor(client.user!)?.has(PermissionFlagsBits.SendMessages)) {
        await sent.crosspost();
      }
      await Subscription.findByIdAndUpdate(subscription._id, {
        lastCommentId: newComment.html_url,
        lastCommentCreatedAt: new Date(newComment.created_at)
      });
    } catch (err) {
      console.error('Error sending preview message:', err);
    }
  }
}