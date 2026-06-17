import { Router } from 'express';
import type { Relationship, FactVersion } from '@greenhouse-resume-builder/shared';
import { relationshipRepo, factVersionRepo } from '../db/repo';

const router = Router();

router.get('/:personId/suggested', async (req: any, res: any) => {
  try {
    const personId = req.params.personId;
    const candidates = await relationshipRepo.suggested(personId);

    const expFacts = await factVersionRepo.allByPersonSection(personId, 'experience');
    const typedExpFacts: FactVersion[] = (expFacts as unknown as FactVersion[]);

    res.json({
      candidates: (candidates as unknown as Relationship[]).map(r => ({
        relationshipId: r.id, fromPersonId: r.fromPersonId, toPersonId: r.toPersonId,
        relationshipType: r.relationshipType, status: r.status, confidence: r.confidence ?? 0,
      })),
      evidenceFacts: typedExpFacts.map(f => ({ factKey: f.factKey, factValue: f.factValue, personId: f.personId })),
    });
  } catch (err) {
    console.error('[Relationships] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:relationshipId', async (req: any, res: any) => {
  try {
    const status = req.body.status;

    if (status === 'suggested') {
      const exists = await relationshipRepo.edgeExists(req.body.fromPersonId, req.body.toPersonId);
      if (exists) return res.status(409).json({ error: 'Edge already exists' });

      const relId = `rel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await relationshipRepo.create({
        id: relId, tenantId: req.user?.tenantId || req.tenantId || 'tenant',
        fromPersonId: req.body.fromPersonId, toPersonId: req.body.toPersonId,
        relationshipType: req.body.relationshipType || 'shared_employer',
        status: 'suggested' as const,
        inferredByAgent: false,
        evidenceFactVersionIds: [], evidenceSourceDocumentIds: [],
      } as unknown as (Relationship & { id: string }) as any);

      // Return aligned with Relationship DTO (no hardcoded defaults)
      res.status(201).json({
        id: relId,
        tenantId: req.user?.tenantId || req.tenantId || 'tenant',
        fromPersonId: req.body.fromPersonId,
        toPersonId: req.body.toPersonId,
        relationshipType: req.body.relationshipType || 'shared_employer',
        status: 'suggested' as const,
        inferredByAgent: false,
        evidenceFactVersionIds: [],
        evidenceSourceDocumentIds: [],
      });
    } else if (status === 'confirmed' || status === 'rejected') {
      const edge = await relationshipRepo.getById(req.params.relationshipId);
      if (!edge) return res.status(404).json({ error: 'Not found' });

      await relationshipRepo.updateStatus(req.params.relationshipId, status as Relationship['status'], req.user?.id || req.userId || 'system');
      res.json({ updated: true });
    } else {
      res.status(400).json({ error: 'Invalid status' });
    }
  } catch (err) {
    console.error('[Relationships] Patch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
