import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { AuditWriter } from '../../../shared/ports/audit-writer.js';
import type { IdentityChannel } from '../domain/channel-link.js';
import type { ChannelLinkRepository, UserRepository } from '../ports/identity-ports.js';

interface UnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

const STAFF_ROLES = new Set(['operator', 'admin']);
export const UNLINKABLE_CHANNELS: readonly IdentityChannel[] = ['telegram', 'whatsapp'];

/** Staff-assisted actions on a user's identity, each audited in the same transaction. */
export class IdentityStaffService {
  constructor(
    private readonly users: UserRepository,
    private readonly links: ChannelLinkRepository,
    private readonly audit: AuditWriter,
    private readonly uow: UnitOfWork,
  ) {}

  /**
   * Removes a user's messaging link (lost phone, changed chat). The bot stops writing to that
   * chat; the user can link again by sharing the contact. The audit log keeps the channel only.
   */
  async unlinkChannel(
    actor: { readonly sub: string; readonly role: string },
    userId: string,
    channel: string,
  ): Promise<void> {
    if (!STAFF_ROLES.has(actor.role)) throw new DomainError('No autorizado.', 'forbidden');
    if (!UNLINKABLE_CHANNELS.includes(channel as IdentityChannel))
      throw new DomainError('Canal no válido.', 'invalid_channel');
    await this.uow.run(async () => {
      if (!(await this.users.findById(userId)))
        throw new DomainError('Usuario no encontrado.', 'not_found');
      const removed = await this.links.deleteForUser(userId, channel);
      if (!removed) throw new DomainError('El usuario no tiene ese canal vinculado.', 'not_found');
      await this.audit.record({
        actorId: actor.sub,
        actorRole: actor.role,
        action: 'channel.unlink',
        entity: 'user',
        entityId: userId,
        before: { channel, verified: removed.verifiedAt !== null },
        after: null,
      });
    });
  }
}
