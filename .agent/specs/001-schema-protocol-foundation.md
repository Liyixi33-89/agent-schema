---
spec_id: 001-schema-protocol-foundation
status: active
created: 2026-10-26
last_verified_at: 2026-10-27
owner: 待定
---

# Spec 路 Schema 鍗忚灞傚鍩猴紙P1 棣栦换鍔★級

## 1. 鑳屾櫙涓庣洰鏍?
鍗忚灞傛槸鍏ㄥ钩鍙板湴鍩猴紙鍓嶇鏂囨。 01 / 鍚庣鏂囨。 01 鐨勫叡鍚屼笂娓革級銆侾RD 搂6.1/搂6.2 鍐崇瓥瑕佹眰瀛楁鐘舵€佹満銆佽〃杈惧紡鐧藉悕鍗曘€佸弻绔绾﹂暅鍍忎粠绗竴澶╂垚绔嬨€備笉鍋氬垯鍚庣画鎵€鏈夋ā鍧楋紙娓叉煋/琛ㄥ崟/寤烘ā鍣?鏁版嵁寮曟搸锛夋病鏈夊彲渚濊禆鐨勭ǔ瀹氬唴鏍搞€?
## 2. 鑼冨洿澹版槑

**鍋?*锛?- `schema-frontend/packages/schema-protocol` 鍖呴鏋讹紙闆惰繍琛屾椂渚濊禆锛?- 绫诲瀷浣撶郴锛歁odelSchema/FieldSchema/PageSchema/LayoutNode/ExpressionBinding锛堝墠绔枃妗?01 搂2锛?- zod 鏍￠獙鍣?+ JSON Pointer 閿欒璺緞
- ExprEngine锛歍okenizer鈫扨ratt Parser鈫扐ST鈫扙valuator锛岀櫧鍚嶅崟 `functions.json`锛?000 姝ヤ笂闄?- `extractDepends` 闈欐€佷緷璧栨彁鍙?- schemaVersion 杩佺Щ绠＄嚎楠ㄦ灦锛坢igrate + FutureSchemaVersionError锛?- `zod-to-json-schema` 瀵煎嚭鑴氭湰 鈫?`contract/` 鐩綍锛堜緵鍚庣 diff锛?
**涓嶅仛**锛?- React 娓叉煋闆嗘垚锛坰pec-002锛屾覆鏌撳紩鎿庝换鍔★級
- 鍚庣 `schema-protocol-java` 瀹炵幇锛堝悗绔嫭绔?spec锛涙湰鏈熷彧浜や粯鍓嶇瀵煎嚭鐨勫绾︽枃浠讹級
- 杩佺Щ鍑芥暟鐨勭湡瀹炲巻鍙茬増鏈紪鍐欙紙褰撳墠 LATEST=1锛岀绾跨┖杞嵆鍙級

## 3. 鎺ュ彛濂戠害

```ts
// 鍖呭叕鍏卞鍑猴紙index.ts锛夆€斺€旂鍚嶅喕缁擄紝鏀瑰姩闇€鍥炴湰鑺傛洿鏂?export const LATEST_SCHEMA_VERSION: number;
export function validate(schema: unknown): { ok: true; data: PageSchema | ModelSchema } | { ok: false; errors: JsonPointerError[] };
export function migrate(schema: AnySchema): AnySchema;            // 鎶?FutureSchemaVersionError
export const ExprEngine: {
  compile(source: string): { ast: ExprNode } | { error: CompileError };
  evaluate(ast: ExprNode, scope: Record<string, unknown>): { value: unknown } | { error: EvalError };
  extractDepends(ast: ExprNode): string[];
};
```

## 4. Tasks

- [ ] T1 鍖呴鏋?+ tsconfig strict + Vitest 灏辩华锛堥浂渚濊禆鏂█锛?- [ ] T2 绫诲瀷浣撶郴 + zod schema锛堝惈 LayoutNode 閫掑綊 lazy锛?- [ ] T3 ExprEngine 鐧藉悕鍗曞嚱鏁板叏闆嗭紙绾?20 涓紝浠?`functions.json` 涓虹湡婧愶級
- [ ] T4 姝ユ暟涓婇檺 + 绫诲瀷闈欐€佹帹鏂姤閿?- [ ] T5 杩佺Щ绠＄嚎 + FutureSchemaVersionError
- [ ] T6 濂戠害瀵煎嚭鑴氭湰锛坺od 鈫?json-schema 鈫?`contract/`锛?- [ ] T7 鏂囨。 01 搂7 鍗曞厓娴嬭瘯纭€ц姹傚叏缁?
## 5. Acceptance

- [ ] A1 `verify -Level commit` 閫氳繃锛堝惈鏈?spec 闃茶厫妫€鏌ラ」锛?- [ ] A2 `schema-protocol` 渚濊禆鏁?= 0锛坧ackage.json dependencies 涓虹┖锛宒evDependencies 浠呯被鍨?娴嬭瘯锛?- [ ] A3 鏂囨。 01 搂7 鍏ㄩ儴鐢ㄤ緥閫氳繃锛氱孩绾胯娉曟嫆缁濓紙鍚鍙峰垪鍙凤級銆丒valBudgetError銆丏ELETED 瀛楁璁捐鎬侀樆鏂€佽縼绉荤粓楠?- [ ] A4 `functions.json` 瀛樺湪涓旇 ExprEngine 娑堣垂锛堜笉鏄‖缂栫爜鐧藉悕鍗曪級
- [ ] A5 濂戠害瀵煎嚭鐗╄惤 `contract/` 涓斿彲琚?CI diff 鏍￠獙

## 6. 楠岃瘉姝ラ

```text
1. pwsh scripts/verify.ps1 -Level commit
2. cd schema-frontend && pnpm --filter schema-protocol test
3. 瑙傚療杈撳嚭锛氬叏閮ㄧ敤渚嬬豢锛汚2/A4 鏂█鐢ㄤ緥鍦ㄥ垪
```

## 7. 娌夋穩璁板綍

锛堢粨椤瑰洖濉級
