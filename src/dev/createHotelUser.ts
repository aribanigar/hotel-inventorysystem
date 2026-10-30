/**
 * Creates (or updates) a hotel staff login and grants access to one hotel.
 *
 *   npx tsx src/dev/createHotelUser.ts <email> "<name>" <hotelId> <owner|manager|frontdesk>
 *
 * The password is read from the HOTEL_USER_PASSWORD env var so it never lands in shell
 * history. If unset, a strong random one is generated and printed once.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { hashPassword, passwordProblems } from '../extranet/passwords.js';

export async function createHotelUser(email: string, name: string, hotelId: string, role: 'owner' | 'manager' | 'frontdesk', password: string) {
  const problem = passwordProblems(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO hotel_users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [email.trim(), name.trim(), hash],
  );
  const userId = rows[0].id as string;
  await pool.query(
    `INSERT INTO hotel_user_access (user_id, hotel_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, hotel_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, hotelId, role],
  );
  return userId;
}

const isMain = process.argv[1]?.endsWith('createHotelUser.ts') || process.argv[1]?.endsWith('createHotelUser.js');
if (isMain) {
  const [email, name, hotelId, role] = process.argv.slice(2);
  if (!email || !name || !hotelId || !['owner', 'manager', 'frontdesk'].includes(role ?? '')) {
    console.error('usage: createHotelUser.ts <email> "<name>" <hotelId> <owner|manager|frontdesk>');
    process.exit(1);
  }
  const password = process.env.HOTEL_USER_PASSWORD ?? `Hx${randomBytes(9).toString('base64url')}7`;
  createHotelUser(email, name, hotelId, role as 'owner', password)
    .then((id) => {
      console.log(`user ${id} can now manage hotel ${hotelId} as ${role}`);
      if (!process.env.HOTEL_USER_PASSWORD) console.log(`generated password (shown once): ${password}`);
      return pool.end();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
