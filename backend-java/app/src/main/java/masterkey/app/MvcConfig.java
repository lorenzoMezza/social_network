// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import java.util.List;
import masterkey.api.web.ViewerResolver;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** A {@code Viewer} parameter in a controller: the signed-in user (ViewerResolver). */
@Configuration(proxyBeanMethods = false)
class MvcConfig implements WebMvcConfigurer {

    private final ViewerResolver viewers;

    MvcConfig(ViewerResolver viewers) {
        this.viewers = viewers;
    }

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(viewers);
    }
}
