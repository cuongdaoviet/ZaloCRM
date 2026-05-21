/**
 * appointment-reminder.ts — Cron job that emits Socket.IO reminders
 * for appointments scheduled tomorrow.
 * Runs daily at 08:00 Vietnam time (01:00 UTC).
 */
import cron from 'node-cron';
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { emitWebhook } from '../api/webhook-service.js';

export function startAppointmentReminder(io: Server): void {
  // 01:00 UTC = 08:00 Vietnam time (UTC+7)
  cron.schedule('0 1 * * *', async () => {
    logger.info('[reminder] Checking tomorrow appointments...');

    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const startOfDay = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
      const endOfDay = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59, 999);

      const appointments = await prisma.appointment.findMany({
        where: {
          appointmentDate: { gte: startOfDay, lte: endOfDay },
          status: 'scheduled',
          reminderSent: false,
        },
        include: {
          contact: { select: { orgId: true, fullName: true, phone: true } },
          assignedUser: { select: { id: true, fullName: true } },
        },
      });

      for (const apt of appointments) {
        io.emit('appointment:reminder', {
          appointmentId: apt.id,
          contactName: apt.contact.fullName,
          contactPhone: apt.contact.phone,
          date: apt.appointmentDate,
          time: apt.appointmentTime,
          type: apt.type,
          assignedUserId: apt.assignedUserId,
          assignedUserName: apt.assignedUser?.fullName,
        });

        // Feature 0038 — tee reminder into Integration Hub so Telegram bots
        // subscribed to `appointment.reminder` push the alert to ops chat.
        void emitWebhook(apt.contact.orgId, 'appointment.reminder', {
          appointmentId: apt.id,
          contactName: apt.contact.fullName,
          contactPhone: apt.contact.phone,
          time: apt.appointmentTime ?? apt.appointmentDate.toISOString(),
          appointmentDate: apt.appointmentDate.toISOString(),
          assignedUserName: apt.assignedUser?.fullName ?? null,
        });

        await prisma.appointment.update({
          where: { id: apt.id },
          data: { reminderSent: true },
        });
      }

      logger.info(`[reminder] Sent ${appointments.length} reminder(s)`);
    } catch (err) {
      logger.error('[reminder] Cron job error:', err);
    }
  });

  logger.info('[reminder] Appointment reminder cron started (daily 01:00 UTC)');
}
