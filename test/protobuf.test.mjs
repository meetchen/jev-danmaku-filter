import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeSegment, filterSegment, readFields } from '../src/adapters/bilibili/protobuf.js';
import { parseDanmakuXml } from '../src/adapters/bilibili/xml.js';

const seg = new Uint8Array(readFileSync(new URL('./fixtures/seg1.bin', import.meta.url)));

test('解码 B 站分段拿到弹幕文本', () => {
  const items = decodeSegment(seg);
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.equal(typeof item.text, 'string');
    assert.ok(item.text.length > 0);
    assert.ok(Number.isFinite(item.at));
  }
});

test('过滤后剩余弹幕正确，且非弹幕字段原样保留', () => {
  const all = decodeSegment(seg);
  const target = all[0].text;
  const { bytes, total, dropped } = filterSegment(seg, text => text === target);
  assert.equal(total, all.length);
  assert.equal(dropped, 1);
  // 被丢弃的元素按整段 span 移走，其余字段逐字节保留
  const survivors = decodeSegment(bytes);
  assert.equal(survivors.length, all.length - 1);
  assert.ok(!survivors.some(item => item.text === target));

  const otherFields = buffer => readFields(buffer).filter(f => f.field !== 1).map(f => [...buffer.subarray(f.start, f.end)]);
  assert.deepEqual(otherFields(bytes), otherFields(seg));
});

test('全部命中时输出只剩非弹幕字段', () => {
  const { bytes, dropped } = filterSegment(seg, () => true);
  assert.equal(dropped, decodeSegment(seg).length);
  assert.equal(decodeSegment(bytes).length, 0);
  assert.ok(bytes.length > 0); // state / config 等字段仍在
});

test('不接受被截断的 buffer', () => {
  assert.throws(() => decodeSegment(seg.subarray(0, seg.length - 1)));
});

test('解析旧版 XML 弹幕', () => {
  const items = parseDanmakuXml('<i><d p="412.06,1,25,16777215,1789004918,0,dc35ef0,2197091517842118400,10">这就是消费主义</d><d p="1.5,4,25,16711680,1,0,aa,123,5">字幕&amp;特效</d></i>');
  assert.equal(items.length, 2);
  assert.equal(items[0].text, '这就是消费主义');
  assert.equal(items[0].at, 412.06);
  assert.equal(items[0].mode, 1);
  assert.equal(items[1].text, '字幕&特效');
  assert.equal(items[1].mode, 4);
});
