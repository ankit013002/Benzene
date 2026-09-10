package com.nebulavault.gateway;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.cloud.gateway.route.Route;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import reactor.core.publisher.Mono;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class NebulaGatewayApplicationTests {

	@Autowired
	private List<RouteLocator> routeLocators;

	@Test
	void contextLoads() {
	}

	@Test
	void exposesPlacementAuthAndAgentRoutes() {
		Set<String> routeIds = new HashSet<>();
		Route placement = null;
		Route auth = null;
		for (RouteLocator locator : routeLocators) {
			List<Route> routes = locator.getRoutes().collectList().block();
			if (routes != null) {
				routes.stream().map(Route::getId).forEach(routeIds::add);
				for (Route route : routes) {
					if (route.getId().equals("placement")) placement = route;
					if (route.getId().equals("auth-api")) auth = route;
				}
			}
		}

		assertThat(routeIds).contains("placement", "auth-api", "node-agent");
		assertThat(placement).isNotNull();
		assertThat(auth).isNotNull();
		assertThat(Mono.from(placement.getPredicate().apply(exchange("/placement/upload-targets"))).block()).isTrue();
		for (String endpoint : List.of("signup", "login", "logout", "refresh",
				"verify-email", "resend-verification", "forgot-password", "reset-password")) {
			assertThat(Mono.from(auth.getPredicate().apply(exchange("/auth/" + endpoint))).block())
					.as("/auth/%s is routed to the auth service", endpoint).isTrue();
		}
	}

	private static MockServerWebExchange exchange(String path) {
		return MockServerWebExchange.from(MockServerHttpRequest.get(path).build());
	}

}
