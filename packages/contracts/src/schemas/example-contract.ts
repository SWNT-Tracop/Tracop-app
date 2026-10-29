import { z } from 'zod';

export const exampleContractSchema = z.object({ id: z.string().uuid() });
