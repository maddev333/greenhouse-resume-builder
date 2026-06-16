import { Router } from 'express';
import type { Annotation, FactVersion as SharedFact } from '@greenhouse-resume-builder/shared';
import { annotationRepo, factVersionRepo } from '../db/repo';

const router = Router();

router.put('/:id', async (req: any, res: any) => {
  const body = req.body;
  if (!body?.commentText) return res.status(400).json({ error: 'Missing commentText' });

  try {
    if (body.targetFactVersionId) {
      const fv = await factVersionRepo.getById(body.targetFactVersionId);
      if (!fv) return res.status(404).json({ error: 'FactVersion not found' });
    }

    const existing = await annotationRepo.getById(req.params.id);
    const personId = body.targetFactVersionId
      ? (await factVersionRepo.getById(body.targetFactVersionId))?.personId || 'unknown'
      : (req.user?.personId) || 'unknown';

    const annotation: Annotation = {
      id: req.params.id ?? `ann_${Date.now()}`,
      tenantId: req.user?.tenantId || 'tenant',
      personId,
      targetType: 'factVersion',
      targetFactVersionId: body.targetFactVersionId || '',
      commentText: body.commentText,
      createdByUserId: req.user?.id || 'system',
      createdAt: existing?.createdAt || new Date().toISOString(),
      status: (existing as any)?.status || 'open',
    };

    await annotationRepo.upsert(annotation);

    // Return full Annotation shape aligned with shared interface
    res.json({
      id: annotation.id,
      tenantId: annotation.tenantId,
      personId: annotation.personId,
      targetType: annotation.targetType,
      targetFactVersionId: annotation.targetFactVersionId,
      commentText: annotation.commentText,
      createdByUserId: annotation.createdByUserId,
      createdAt: annotation.createdAt,
      status: annotation.status,
    });
  } catch (err) {
    console.error('[Annotations] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req: any, res: any) => {
  try {
    const fvId = req.query.factVersionId as string | undefined;
    const pid = req.query.personId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;

    let annotations: Annotation[] = [];
    if (fvId) {
      annotations = await annotationRepo.byFactVersion(fvId, limit);
    } else if (pid) {
      annotations = await annotationRepo.byPerson(pid, limit);
    }

    res.json((annotations as unknown as Annotation[]).map(a => ({
      id: a.id, commentText: a.commentText, targetFactVersionId: a.targetFactVersionId,
      status: a.status, createdAt: a.createdAt, createdByUserId: a.createdByUserId,
      personId: a.personId,
    })));
  } catch (err) {
    console.error('[Annotations] List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id', async (req: any, res: any) => {
  try {
    const status = req.body.status as 'open' | 'resolved';
    // updateStatus returns void; fetch the updated annotation
    await annotationRepo.updateStatus(req.params.id, status);
    const updated = await annotationRepo.getById(req.params.id);
    
    if (!updated) {
      return res.status(404).json({ error: 'Annotation not found after update' });
    }
    // Return full Annotation shape (not bare {updated: true})
    res.json({
      id: updated.id,
      tenantId: updated.tenantId,
      personId: updated.personId,
      targetType: updated.targetType,
      targetFactVersionId: updated.targetFactVersionId,
      commentText: updated.commentText,
      createdByUserId: updated.createdByUserId,
      createdAt: updated.createdAt,
      status: updated.status,
    });
  } catch (err) {
    console.error('[Annotations] Patch error:', err);
    // NotFound propagates from updateStatus via thrown Error
    if ((err as Error).message.includes('not found')) {
      return res.status(404).json({ error: 'Annotation not found' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req: any, res: any) => {
  try {
    const ann = await annotationRepo.getById(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Not found' });
    await annotationRepo.delete(req.params.id);
    res.status(204).send();
  } catch (err) {
    console.error('[Annotations] Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
