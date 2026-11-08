/** Native chat attachment bytes, prepared by the authenticated local asset owner.
 * URLs, local paths and executable attachment metadata are never accepted here.
 */
const fail=()=>Object.assign(new Error('Native attachments must be bounded inline file bytes.'),{code:'OPENCLAW_ATTACHMENT_INVALID',status:400});
export function validateNativeAttachments(value) {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>10||Object.keys(value).length!==value.length)throw fail();
  let total=0;
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['type','mimeType','fileName','origin','content','sizeBytes','durationMs','width','height'].includes(key))||
      typeof item.content!=='string'||item.content.length===0||item.content.length>28*1024*1024||item.content.length%4!==0||/[^A-Za-z0-9+/=]/u.test(item.content)||
      typeof item.mimeType!=='string'||item.mimeType.length>128||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(item.mimeType)||
      item.fileName!==undefined&&(typeof item.fileName!=='string'||item.fileName.length>255||/[\0\r\n\\/]/u.test(item.fileName))||
      item.type!==undefined&&(typeof item.type!=='string'||!/^[a-z-]{1,32}$/u.test(item.type))||
      item.origin!==undefined&&!['paste','file'].includes(item.origin))throw fail();
    const bytes=Buffer.from(item.content,'base64');total+=bytes.length;
    if(!bytes.length||bytes.length>20*1024*1024||total>20*1024*1024||bytes.toString('base64')!==item.content||
      item.sizeBytes!==undefined&&item.sizeBytes!==bytes.length)throw fail();
    for(const key of ['durationMs','width','height'])if(item[key]!==undefined&&(!Number.isFinite(item[key])||item[key]<0||item[key]>86400000))throw fail();
    return {...item,sizeBytes:bytes.length};
  });
}
