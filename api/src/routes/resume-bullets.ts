import { Router } from 'express';
import type {
  BulletMapping,
  DiffResult,
  FactVersion,
  FactVersionResponse,
  ResumeBulletResponse,
} from '@greenhouse-resume-builder/shared';
import { bulletMappingRepo, factVersionRepo } from '../db/repo';

const router = Router();

router.get('/:personId/bullet-mappings', async (req: any, res: any) => {
  const personId = req.params.personId;
  const section = (req.query.section as string | undefined)
                || ['summary', 'experience', 'skills', 'education'];
  const sections: string[] = Array.isArray(section) ? section : [section];

  // Return a flat array aligned with ResumeBulletResponse DTO
  let results: ResumeBulletResponse[] = [];

  for (const sec of sections) {
    const bullets = await bulletMappingRepo.allByPersonSection(personId, sec);
    results.push(...(bullets as unknown as BulletMapping[]).map(b => ({
      bulletId: b.id,
      sectionId: b.sectionId as string,
      bulletText: b.bulletText,
      citationFactVersionIds: b.citationFactVersionIds,
      citationSourceDocumentIds: b.citationSourceDocumentIds,
    })));
  }
  res.json(results);
});

router.get('/:personId/facts', async (req: any, res: any) => {
  const personId = req.params.personId;
  const section = (req.query.section as string | undefined)
               || ['summary', 'experience', 'skills', 'education'];
  const secList: string[] = Array.isArray(section) ? section : [section];

  // Return FactVersionResponse-aligned shapes per-section
  let sections: Record<string, FactVersionResponse[]> = {};

  for (const sec of secList) {
    const facts = await factVersionRepo.allByPersonSection(personId, sec);
    sections[sec] = (facts as unknown as FactVersion[]).map(f => ({
      factVersionId: f.id,
      extractionRunId: f.extractionRunId,
      sectionId: f.sectionId,
      factKey: f.factKey,
      factValue: f.factValue,
      normalizedValue: f.normalizedValue,
      extractedAt: f.extractedAt,
      confidence: f.confidence ?? 0,
    }));
  }
  res.json({ personId, sections });
});

router.get('/:personId/differences', async (req: any, res: any) => {
  const personId = req.params.personId;

  // Get latest two runs for this person
  const allRuns = await factVersionRepo.distinctRunIdsByPerson(personId, 2);

  if (allRuns.length < 2) { return res.json([]); }
  const prevRunId = allRuns[1];

  let prevBulletMap: Record<string, BulletMapping> = {};
  const prevBulletsRaw = await bulletMappingRepo.allByRun(prevRunId);

  for (const b of prevBulletsRaw) {
    if (!prevBulletMap[b.bulletSignature]) prevBulletMap[b.bulletSignature] = b;
  }

  const curRunId = allRuns[0];
  const curBullets = await bulletMappingRepo.allByRunAndSection(curRunId, 'experience');

  // Return diff shapes aligned with DiffResult DTO
  const diffs: DiffResult[] = [];
  for (const b of curBullets) {
    if (!prevBulletMap[b.bulletSignature]) {
      diffs.push({
        type: 'added',
        bulletId: b.id,
        currentBulletText: b.bulletText,
        citationChangeSummary: `Added citations: ${b.citationFactVersionIds.length} facts`,
      });
    } else if (prevBulletMap[b.bulletSignature]!.bulletText !== b.bulletText) {
      diffs.push({
        type: 'changed',
        bulletId: b.id,
        previousBulletText: prevBulletMap[b.bulletSignature]!.bulletText,
        currentBulletText: b.bulletText,
        citationChangeSummary: 'Citations updated',
      });
    }
  }

  const remainingSigs = new Set(curBullets.map(b => b.bulletSignature));
  for (const sig of Object.keys(prevBulletMap)) {
    if (!remainingSigs.has(sig)) {
      diffs.push({
        type: 'removed',
        bulletId: prevBulletMap[sig].id,
        previousBulletText: prevBulletMap[sig].bulletText,
        currentBulletText: '', // no current text for removed items
        citationChangeSummary: 'Removed',
      });
    }
  }

  res.json(diffs);
});

export default router;
