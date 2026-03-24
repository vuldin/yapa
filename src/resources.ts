import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CHROMA_URL, EMBEDDING_PROVIDER, USERNAME, getEmbeddingModel } from './config.js';
import { listCollectionsWithCounts } from './collections/manage.js';
import { listTasks, getDueTasks } from './tasks/list.js';
import { formatTaskDate } from './tasks/dates.js';

export function registerResources(server: McpServer): void {
  server.resource(
    'config',
    'yapa://config',
    { description: 'Current YAPA configuration' },
    async () => ({
      contents: [{
        uri: 'yapa://config',
        mimeType: 'application/json',
        text: JSON.stringify({
          chromaUrl: CHROMA_URL,
          embeddingProvider: EMBEDDING_PROVIDER,
          embeddingModel: getEmbeddingModel(),
          username: USERNAME,
        }, null, 2),
      }],
    }),
  );

  server.resource(
    'collections',
    'yapa://collections',
    { description: 'All collections with document counts' },
    async () => {
      const collections = await listCollectionsWithCounts();
      return {
        contents: [{
          uri: 'yapa://collections',
          mimeType: 'application/json',
          text: JSON.stringify(collections, null, 2),
        }],
      };
    },
  );

  server.resource(
    'dashboard',
    'yapa://dashboard',
    { description: 'Task dashboard: overdue, due today, in-progress, blocked' },
    async () => {
      const [due, inProgress, blocked] = await Promise.all([
        getDueTasks(true),
        listTasks({ status: 'in_progress' }),
        listTasks({ status: 'blocked' }),
      ]);

      const overdue = due.filter(t => t.daysUntil < 0);
      const dueToday = due.filter(t => t.daysUntil === 0);
      const upcoming = due.filter(t => t.daysUntil > 0 && t.daysUntil <= 7);

      const sections: string[] = [];

      if (overdue.length) {
        sections.push('## Overdue\n' + overdue.map(t =>
          `- **${t.id}** ${t.title} (${Math.abs(t.daysUntil)} days overdue)`
        ).join('\n'));
      }

      if (dueToday.length) {
        sections.push('## Due Today\n' + dueToday.map(t =>
          `- **${t.id}** ${t.title}`
        ).join('\n'));
      }

      if (upcoming.length) {
        sections.push('## Upcoming (7 days)\n' + upcoming.map(t =>
          `- **${t.id}** ${t.title} (${formatTaskDate(t.metadata.due_date)})`
        ).join('\n'));
      }

      if (inProgress.length) {
        sections.push('## In Progress\n' + inProgress.map(t =>
          `- **${t.id}** ${t.title} [${t.collection}]`
        ).join('\n'));
      }

      if (blocked.length) {
        sections.push('## Blocked\n' + blocked.map(t =>
          `- **${t.id}** ${t.title} [${t.collection}]`
        ).join('\n'));
      }

      const text = sections.length ? sections.join('\n\n') : 'All clear — no urgent tasks.';

      return {
        contents: [{
          uri: 'yapa://dashboard',
          mimeType: 'text/markdown',
          text,
        }],
      };
    },
  );
}
