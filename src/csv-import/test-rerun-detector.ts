import { detectRecurring } from "./recurring-detector.js";
import { getDb } from "../db/connection.js";

const result = detectRecurring();
console.log("Detector result:", result);

const excluded = getDb()
  .prepare(
    `SELECT description, frequency, last_date, is_active
       FROM recurring
      WHERE description LIKE '%PET INSURANCE%'
         OR description LIKE '%AUDIBLE%'
         OR description LIKE '%FARMERS LAND%'
         OR description LIKE '%PYPL PAYIN%'
      ORDER BY description`,
  )
  .all();
console.log("Excluded streams (should all be is_active=0):");
console.log(excluded);

const uniting = getDb()
  .prepare(
    `SELECT description, frequency, last_date, last_amount, is_active, stream_type
       FROM recurring
      WHERE description LIKE '%UNITING%'`,
  )
  .get();
console.log("Uniting stream (control — should still be active):");
console.log(uniting);
