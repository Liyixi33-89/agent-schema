package com.schema.metering.application;

import com.schema.platform.common.event.LoginSucceededEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 登录成功埋点监听（09BE §4 seat.active 服务端终审扩展）：
 * 登录成功事件 → usage_event(metric=seat.active, source=SERVER)。
 * 登录即活跃触发——rollingActiveSeats 滚动 30 天口径据此去重计活跃席位。
 */
@Component
public class LoginMeteringListener {

    private final MeteringEventService service;

    public LoginMeteringListener(MeteringEventService service) {
        this.service = service;
    }

    @EventListener
    public void on(LoginSucceededEvent event) {
        service.recordServer(event.tenantId(), event.userId(), "seat.active", 1L, null,
                "{\"surface\":\"login\"}");
    }
}