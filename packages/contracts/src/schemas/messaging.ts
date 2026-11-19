import { z } from 'zod';

const telegramIdSchema = z.union([z.number().int(), z.string().regex(/^\d+$/)]);

export const telegramUpdateSchema = z
  .object({
    update_id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
    message: z
      .object({
        message_id: telegramIdSchema.optional(),
        date: z.number().int().nonnegative().optional(),
        chat: z
          .object({
            id: telegramIdSchema,
            type: z.string(),
          })
          .passthrough(),
        from: z
          .object({
            id: telegramIdSchema,
            is_bot: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        text: z.string().optional(),
        contact: z
          .object({
            phone_number: z.string().min(1),
            user_id: telegramIdSchema.optional(),
            first_name: z.string().optional(),
          })
          .passthrough()
          .optional(),
        voice: z.object({ file_id: z.string().optional() }).passthrough().optional(),
        photo: z.array(z.object({ file_id: z.string().optional() }).passthrough()).optional(),
        location: z
          .object({ latitude: z.number(), longitude: z.number() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    edited_message: z.unknown().optional(),
    channel_post: z.unknown().optional(),
    my_chat_member: z.unknown().optional(),
    callback_query: z.unknown().optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
