package com.schema.metadata.interfaces.rest;

import com.schema.metadata.application.MetadataCommandService;
import com.schema.metadata.domain.model.ChangeOp;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 模型管理 REST（01BE §4.1/§4.2/§4.4 附录 A）。
 * 接口层只做协议转换与租户上下文装配（无业务逻辑——四层职责铁律）。
 */
@RestController
@RequestMapping("/api/models")
public class ModelController {

    private final MetadataCommandService service;

    public ModelController(MetadataCommandService service) {
        this.service = service;
    }

    @PostMapping
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        return service.createModel(str(body.get("modelKey")), str(body.get("name")), str(body.get("icon")));
    }

    @GetMapping
    public Map<String, Object> list(@RequestParam(required = false) String keyword,
            @RequestParam(name = "includeDeleted", defaultValue = "false") boolean includeDeleted) {
        return service.listModels(keyword, includeDeleted);
    }

    @GetMapping("/{id}")
    public Map<String, Object> detail(@PathVariable long id) {
        return service.getModel(id);
    }

    @PutMapping("/{id}")
    public Map<String, Object> update(@PathVariable long id, @RequestBody Map<String, Object> body) {
        service.updateModel(id, str(body.get("name")), str(body.get("icon")));
        return Map.of();
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable long id, @RequestBody(required = false) Map<String, Object> body) {
        // 两段式（01BE §4.1/§4.3）：带 confirmToken = 确认提交；不带 = precheck 签发
        if (body != null && body.get("confirmToken") != null) {
            service.deleteModelConfirm(id, str(body.get("confirmToken")), str(body.get("confirmValue")));
            return Map.of();
        }
        return service.deleteModelPrecheck(id);
    }

    @PostMapping("/{id}/precheck")
    public Map<String, Object> precheck(@PathVariable long id, @RequestBody Map<String, Object> body) {
        return service.precheck(id, parseChanges(body.get("changes")));
    }

    @PostMapping("/{id}/schema")
    public Map<String, Object> saveSchema(@PathVariable long id, @RequestBody Map<String, Object> body) {
        return service.saveSchema(id, parseChanges(body.get("changes")),
                intVal(body.get("baseVersion")), str(body.get("confirmToken")),
                str(body.get("confirmValue")));
    }

    @GetMapping("/{id}/versions")
    public Map<String, Object> versions(@PathVariable long id) {
        return service.listVersions(id);
    }

    @GetMapping("/{id}/versions/{version}")
    public Map<String, Object> version(@PathVariable long id, @PathVariable int version) {
        return service.getVersion(id, version);
    }

    @PostMapping("/{id}/rollback/precheck")
    public Map<String, Object> rollbackPrecheck(@PathVariable long id, @RequestBody Map<String, Object> body) {
        return service.rollbackPrecheck(id, intVal(body.get("targetVersion")));
    }

    @PostMapping("/{id}/rollback")
    public Map<String, Object> rollback(@PathVariable long id, @RequestBody Map<String, Object> body) {
        return service.rollback(id, intVal(body.get("targetVersion")), str(body.get("confirmToken")),
                str(body.get("confirmValue")));
    }

    // ---------- 协议转换（ChangeOp 联合体解析，01BE §4.2） ----------

    @SuppressWarnings("unchecked")
    static List<ChangeOp> parseChanges(Object raw) {
        if (!(raw instanceof List<?> list)) {
            throw new IllegalArgumentException("changes 必须为数组");
        }
        List<ChangeOp> result = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m)) {
                throw new IllegalArgumentException("change 必须为对象");
            }
            Map<String, Object> map = (Map<String, Object>) m;
            String op = str(map.get("op"));
            String fieldKey = str(map.get("fieldKey"));
            if (op == null || fieldKey == null) {
                throw new IllegalArgumentException("change 缺 op/fieldKey");
            }
            switch (op) {
                case "ADD_FIELD" -> result.add(new ChangeOp.AddField(fieldKey,
                        map.get("field") instanceof Map<?, ?> f ? (Map<String, Object>) f : Map.of()));
                case "MODIFY_FIELD" -> result.add(new ChangeOp.ModifyField(fieldKey,
                        map.get("patch") instanceof Map<?, ?> p ? (Map<String, Object>) p : Map.of()));
                case "DELETE_FIELD" -> result.add(new ChangeOp.DeleteField(fieldKey));
                case "PROMOTE_COLUMN" -> result.add(new ChangeOp.PromoteColumn(fieldKey));
                default -> throw new IllegalArgumentException("非法 op: " + op);
            }
        }
        return result;
    }

    private static String str(Object v) {
        return v instanceof String s ? s : null;
    }

    private static int intVal(Object v) {
        if (v instanceof Number n) {
            return n.intValue();
        }
        if (v instanceof String s) {
            return Integer.parseInt(s);
        }
        throw new IllegalArgumentException("数值字段缺失或非法");
    }
}
