import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { Clock } from '../../../shared/kernel/clock.js';
import type { AuditWriter } from '../../../shared/ports/audit-writer.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import type { IdentityChannel } from '../domain/channel-link.js';
import { PhoneNumber } from '../domain/phone-number.js';
import { Session } from '../domain/session.js';
import { User, type UserEvent, type UserProps, type UserRole } from '../domain/user.js';
import type {
  ChannelLinkRepository,
  SessionRepository,
  UserRepository,
} from '../ports/identity-ports.js';

interface UnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

type StaffActor = { readonly sub: string; readonly role: string };

const STAFF_ROLES = new Set(['operator', 'admin']);
export const UNLINKABLE_CHANNELS: readonly IdentityChannel[] = ['telegram', 'whatsapp'];
export const ADMIN_REASON_MIN_LENGTH = 3;
export const ADMIN_REASON_MAX_LENGTH = 300;

/** What the admin sees when looking an account up: no full phone, only its last four digits. */
export interface StaffUserView {
  readonly id: string;
  readonly role: UserRole;
  readonly status: UserProps['status'];
  readonly fullName: string;
  readonly phoneLast4: string;
}

export interface IdentityStaffSettings {
  readonly allowedCountryCodes: readonly string[];
}

const view = (user: UserProps): StaffUserView => ({
  id: user.id,
  role: user.role,
  status: user.status,
  fullName: user.fullName,
  phoneLast4: user.phone.value.slice(-4),
});

/** Staff-assisted actions on a user's identity, each audited in the same transaction. */
export class IdentityStaffService {
  constructor(
    private readonly users: UserRepository,
    private readonly links: ChannelLinkRepository,
    private readonly audit: AuditWriter,
    private readonly uow: UnitOfWork,
    private readonly sessions: SessionRepository,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock,
    private readonly settings: IdentityStaffSettings,
  ) {}

  /**
   * Removes a user's messaging link (lost phone, changed chat). The bot stops writing to that
   * chat; the user can link again by sharing the contact. The audit log keeps the channel only.
   */
  async unlinkChannel(actor: StaffActor, userId: string, channel: string): Promise<void> {
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

  /** The admin looks an account up by its phone to change its role or suspend it. */
  async findByPhone(actor: StaffActor, phoneInput: string): Promise<StaffUserView> {
    this.requireAdmin(actor);
    const phone = PhoneNumber.parse(phoneInput, this.settings.allowedCountryCodes);
    if (!phone.ok) throw phone.error;
    const user = await this.users.findByPhone(phone.value);
    if (!user || user.status === 'expired')
      throw new DomainError('Usuario no encontrado.', 'not_found');
    return view(user);
  }

  /**
   * Moves a marketplace account to another marketplace role (a juror who wants to try selling,
   * a buyer who starts producing). Its sessions are revoked so the app signs in again with the
   * new role; requests already follow the role stored here.
   */
  async changeRole(
    actor: StaffActor,
    userId: string,
    input: { readonly role: UserRole; readonly reason: string },
  ): Promise<StaffUserView> {
    return this.act(actor, userId, input.reason, 'user.change_role', (user, now) => {
      const before = user.props.role;
      return { event: user.changeRole(input.role, now), before: { role: before } };
    });
  }

  /** Blocks the account at once (sign-in, refresh and every request); its data is kept. */
  async suspend(
    actor: StaffActor,
    userId: string,
    input: { readonly reason: string },
  ): Promise<StaffUserView> {
    return this.act(actor, userId, input.reason, 'user.suspend', (user, now) => {
      const before = user.props.status;
      return { event: user.suspend(now), before: { status: before } };
    });
  }

  async reactivate(
    actor: StaffActor,
    userId: string,
    input: { readonly reason: string },
  ): Promise<StaffUserView> {
    return this.act(actor, userId, input.reason, 'user.reactivate', (user, now) => ({
      event: user.reactivate(now),
      before: { status: 'suspended' },
    }));
  }

  private async act(
    actor: StaffActor,
    userId: string,
    reasonInput: string,
    action: string,
    change: (user: User, now: Date) => { event: UserEvent; before: Record<string, unknown> },
  ): Promise<StaffUserView> {
    this.requireAdmin(actor);
    const reason = reasonInput.trim();
    if (reason.length < ADMIN_REASON_MIN_LENGTH || reason.length > ADMIN_REASON_MAX_LENGTH)
      throw new DomainError(
        `Escribe un motivo de ${ADMIN_REASON_MIN_LENGTH} a ${ADMIN_REASON_MAX_LENGTH} caracteres.`,
        'invalid_reason',
      );
    if (userId === actor.sub)
      throw new DomainError('No puedes cambiar tu propia cuenta.', 'own_account');
    return this.uow.run(async () => {
      const props = await this.users.findById(userId);
      if (!props || props.status === 'expired')
        throw new DomainError('Usuario no encontrado.', 'not_found');
      if (props.role === 'admin')
        throw new DomainError(
          'Otra cuenta de administración no se modifica aquí.',
          'staff_account',
        );
      const user = User.rehydrate({ ...props });
      const now = this.clock.now();
      const { event, before } = change(user, now);
      await this.users.update(user.props);
      const revoked = await this.sessions.revokeAllForUser(userId, now, action);
      await this.outbox.append([
        { aggregate: userId, type: event.type, payload: { ...event } },
        ...revoked.map((session) => {
          const revokedEvent = new Session(session).revokedEvent(action, now);
          return { aggregate: userId, type: revokedEvent.type, payload: { ...revokedEvent } };
        }),
      ]);
      await this.audit.record({
        actorId: actor.sub,
        actorRole: actor.role,
        action,
        entity: 'user',
        entityId: userId,
        before,
        after: { role: user.props.role, status: user.props.status, reason },
      });
      return view(user.props);
    });
  }

  private requireAdmin(actor: StaffActor): void {
    if (actor.role !== 'admin') throw new DomainError('No autorizado.', 'forbidden');
  }
}
