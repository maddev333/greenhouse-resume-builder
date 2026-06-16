/** Skills Section Agent: extracts technical and professional skill keywords. */

import { app } from 'durable-functions';
import { actx, modelExtractSkills } from '../services/agent-runtime';

export interface ExtractedSkill {
  name:         string;
  proficiency?: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  evidence:     string;
}

/** Known keyword list for matching against resume text. */
const TOPIC_KEYWORDS = [
  // Languages & Frameworks
  'Python', 'Java', 'JavaScript', 'TypeScript', 'C++', 'C#', 'Go', 'Rust', 'Kotlin', 'Swift',
  'React', 'Angular', 'Vue', 'AngularJS', 'Node.js', 'Django', 'Flask', 'Spring Boot',
  'Express.js', 'FastAPI', 'TensorFlow', 'PyTorch', 'NumPy', 'Pandas',
  // Infrastructure & DevOps
  'AWS', 'Azure', 'GCP', 'Google Cloud Platform', 'Terraform', 'Docker',
  'Kubernetes', 'Helm', 'Git', 'GitHub Actions', 'Jenkins', 'CircleCI', 'Circle CI',
  // Data Stores
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'GraphQL',
  // Architecture
  'Microservices', 'REST API', 'gRPC', 'WebSocket', 'Serverless',
  // Soft Skills & Processes
  'Agile', 'Scrum', 'Kanban', 'CI/CD', 'DevOps', 'SRE',
  'Project Management', 'Leadership', 'Technical Writing',
];

/** Lowercase proficiency hints found in the resume. */
const PROFICIENCY_HINTS = {
  beginner:     ['beginner', 'basic', 'familiar with', 'exposure to', 'basic knowledge'],
  intermediate: ['intermediate', 'proficient', 'comfortable', 'working knowledge'],
  advanced:     ['advanced', 'expert', 'senior', 'lead architect', 'principal architect'],
  expert:       ['extensive', 'deep', 'mastery of', 'highly skilled in', 'subject matter expert'],
};

/** Extract skills by matching against known keyword list (case-insensitive). */
export function extractSkills(textBlocks: string[]): ExtractedSkill[] {
  const allText = textBlocks.join('\n');
  const found = new Map<string, ExtractedSkill>();

  for (const kw of TOPIC_KEYWORDS) {
    // Word-boundary match with escaping for special chars
    const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escapedKw}\\b`, 'i');
    if (pattern.test(allText)) {
      found.set(kw.toLowerCase(), {
        name: kw,
        proficiency: undefined,
        evidence: kw,
      });
    }
  }

  // Classify proficiency based on context
  const hints = Object.entries(PROFICIENCY_HINTS);
  for (const [profLevel, hintWords] of hints) {
    for (const [key, skill] of found) {
      if (skill.proficiency || !hintWords) continue;
      const upperLevel: ExtractedSkill['proficiency'] = profLevel as any;

      for (const word of hintWords) {
        // Check if the word appears near this keyword
        const idx = allText.indexOf(skill.name);
        if (idx < 0) continue;
        const contextStart = Math.max(0, idx - 120);
        const contextEnd = idx + skill.name.length + 80;
        const nearby = allText.substring(contextStart, contextEnd).toLowerCase();
        if (nearby.includes(word.toLowerCase())) {
          // Only upgrade if current isn't already higher
          const levels: ExtractedSkill['proficiency'][] = ['beginner', 'intermediate', 'advanced', 'expert'];
          const curIdx = skill.proficiency ? levels.indexOf(skill.proficiency) : -1;
          const newIdx = levels.indexOf(upperLevel);
          if (newIdx > curIdx) {
            skill.proficiency = upperLevel;
          }
        }
      }
    }
  }

  return Array.from(found.values());
}

app.activity('ProcessMvpSkillsSection', {
  handler: async (input: any, context: any) => {
    const c = actx(context);
    const textBlocks = (input?.textBlocks ?? []) as string[];
    const modelResult = await modelExtractSkills(textBlocks.join('\n'), c.logger);
    if (modelResult && modelResult.length > 0) {
      c.logger.info(`[SkillsAgent] Model extracted ${modelResult.length} skills.`);
      return modelResult;
    }
    c.logger.info('[SkillsAgent] Extracting skill keywords (heuristic)...');
    return extractSkills(textBlocks);
  },
});
