import { UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma';

dotenv.config();

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL || 'neuroconcepts@adhd.com.au';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Neuroadmin122!';

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      passwordHash,
      role: UserRole.ADMIN,
    },
    create: {
      email: adminEmail,
      passwordHash,
      role: UserRole.ADMIN,
      practitionerProfile: {
        create: {
          fullName: 'System Administrator',
          clinicName: 'QEEG Platform Administration',
        },
      },
    },
  });

  console.log(`\n======================================================`);
  console.log(`[Seed] 👤 Admin User Verified/Created: ${adminUser.email}`);
  console.log(`[Seed] 🔑 Role: ${adminUser.role}`);
  console.log(`======================================================\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
