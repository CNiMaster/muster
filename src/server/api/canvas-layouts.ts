import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { asyncHandler, param } from './middleware';
import { getCanvasLayout, saveCanvasLayout } from '../domain/canvas-layout';

export const canvasLayoutsRouter = Router();

const canvasNodeSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.unknown()).optional(),
});

const canvasEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
  label: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});

const canvasLayoutDataSchema = z.object({
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
});

canvasLayoutsRouter.get(
  '/:canvasKey',
  asyncHandler(async (req, res) => {
    const layout = getCanvasLayout(getDb(), param(req, 'canvasKey'));
    res.json(layout ?? { canvasKey: param(req, 'canvasKey'), layout: { nodes: [], edges: [] }, version: 0 });
  }),
);

canvasLayoutsRouter.put(
  '/:canvasKey',
  asyncHandler(async (req, res) => {
    const data = canvasLayoutDataSchema.parse(req.body);
    const saved = saveCanvasLayout(getDb(), param(req, 'canvasKey'), data);
    res.json(saved);
  }),
);
