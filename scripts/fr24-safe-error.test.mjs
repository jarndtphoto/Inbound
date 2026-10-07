import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFr24ErrorDetails } from '../src/lib/fr24-safe-error.ts';
test('FR24 diagnostics only expose bounded safe fields and headers', async () => {
 const result = await safeFr24ErrorDetails(new Response(JSON.stringify({code:'CREDITS_EXHAUSTED',message:'Token secret-123 declined',token:'secret-123',account:{email:'x@test.com'}}), {status:402,headers:{'content-type':'application/json','retry-after':'60','set-cookie':'secret-cookie','x-request-id':'req-1'}}), 'secret-123');
 assert.equal(result.code,'CREDITS_EXHAUSTED'); assert.equal(result.message,'Token [redacted] declined');
 assert.equal(result.headers['retry-after'],'60'); assert.equal(result.headers['x-request-id'],'req-1');
 assert.doesNotMatch(JSON.stringify(result),/secret-123|secret-cookie|x@test.com/);
});
test('FR24 diagnostics do not log arbitrary HTML or oversized payloads', async () => {
 assert.equal((await safeFr24ErrorDetails(new Response('<html>private</html>',{status:402}),'token')).message,null);
 assert.equal((await safeFr24ErrorDetails(new Response('x'.repeat(10000),{status:402}),'token')).message,null);
});
