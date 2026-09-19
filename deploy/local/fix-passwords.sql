-- Set a real password for the seeded demo accounts (local only).
-- Password for all three: BidlyDev!2026
update users
   set password_hash = '$argon2id$v=19$m=65536,t=3,p=4$rxHt3hnHnOX+hhWk7LMdwA$J7ehzGnAyYo+deYcbciJjRLSVuU0N1T7JAnAkM1sF5M'
 where email in ('customer@bidly.test', 'provider@bidly.test', 'admin@bidly.test');
