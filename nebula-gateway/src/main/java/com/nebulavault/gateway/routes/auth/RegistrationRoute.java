package com.nebulavault.gateway.routes.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RegistrationRoute {
    @Bean
    public RouteLocator registrationRouteLocator(RouteLocatorBuilder builder, @Value("${routes.auth.uri}") String authUri) {
        return builder.routes()
                // Keep authentication public: these endpoints establish or
                // renew the session cookie that protected routes require.
                // The auth service mounts all handlers under /api/auth, while
                // the gateway exposes the stable /auth/** surface.
                .route("auth-api", r -> r
                        .path("/auth/**")
                        .filters(f -> f
                                .prefixPath("/api")
                                .addResponseHeader("Nebula-Gateway", "Benzene")
                        ).uri(authUri)
                )
                .build();
    }
}
