package com.schema.bootstrap;

import java.util.ArrayList;
import java.util.List;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class CspJsonConfiguration implements WebMvcConfigurer {
    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        for (var converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter json) {
                var types = new ArrayList<>(json.getSupportedMediaTypes());
                types.add(MediaType.valueOf("application/csp-report"));
                json.setSupportedMediaTypes(types);
            }
        }
    }
}
