export const CATEGORIES: Record<string, { label: string; color: string }> = {
  react: { label: 'React', color: 'bg-blue-100 text-blue-800' },
  compiler: { label: 'Compiler', color: 'bg-cyan-100 text-cyan-800' },
  'frontend-architecture': { label: 'Frontend Architecture', color: 'bg-purple-100 text-purple-800' },
  'software-engineering': { label: 'Software Engineering', color: 'bg-green-100 text-green-800' },
  'ai-skill-design': { label: 'AI Skill Design', color: 'bg-orange-100 text-orange-800' },
  'claude-code': { label: 'Claude Code', color: 'bg-rose-100 text-rose-800' },
  general: { label: 'General', color: 'bg-gray-100 text-gray-800' },
};

export type CategoryKey = keyof typeof CATEGORIES & string;

export function isCategoryKey(value: string): value is CategoryKey {
  return value in CATEGORIES;
}
