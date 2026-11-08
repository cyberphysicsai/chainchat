import test from 'node:test';import assert from 'node:assert/strict';
import {validateNativeAttachments} from '../lib/native-attachments.mjs';
test('native attachment transport keeps exact bounded bytes and rejects URL/path/size or protocol substitution',()=>{
 const input={type:'file',mimeType:'text/plain',fileName:'fixture.txt',origin:'file',content:Buffer.from('Synthetic fixture').toString('base64')};
 const result=validateNativeAttachments([input]);assert.equal(Buffer.from(result[0].content,'base64').toString(),'Synthetic fixture');assert.equal(result[0].sizeBytes,17);assert.equal(input.sizeBytes,undefined);
 for(const item of [{...input,content:'https://example.test/private'},{...input,fileName:'../file'},{...input,path:'C:/private'},{...input,sizeBytes:999},{...input,content:'Zh=='},{...input,origin:'remote'}])assert.throws(()=>validateNativeAttachments([item]));
 assert.throws(()=>validateNativeAttachments(new Array(2)));
});
