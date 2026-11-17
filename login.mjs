import { authorize } from './google-auth.mjs';

try {
  await authorize(process.argv[2]);
} catch (error) {
  const googleError = error.response?.data?.error;
  console.error(googleError ? `Google OAuth failed: ${googleError}` : error.message);
  process.exitCode = 1;
}
