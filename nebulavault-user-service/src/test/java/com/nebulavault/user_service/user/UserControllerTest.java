package com.nebulavault.user_service.user;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;

import java.time.OffsetDateTime;
import java.util.UUID;

import static org.hamcrest.Matchers.nullValue;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.http.HttpStatus.NOT_FOUND;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(UserController.class)
class UserControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private UserService userService;

    @Test
    void bootstrapReturnsTheCompleteProfileContract() throws Exception {
        User user = user("auth-sub", "ada@example.com", "Ada");
        when(userService.bootstrap("auth-sub", "ada@example.com", "Ada")).thenReturn(user);

        mockMvc.perform(post("/user/bootstrap")
                        .header("X-User-AuthSub", "auth-sub")
                        .header("X-User-Email", "ada@example.com")
                        .header("X-User-Name", "Ada"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(user.getId().toString()))
                .andExpect(jsonPath("$.email").value("ada@example.com"))
                .andExpect(jsonPath("$.name").value("Ada"))
                .andExpect(jsonPath("$.avatarUrl").value(nullValue()))
                .andExpect(jsonPath("$.plan").value("STARTER"))
                .andExpect(jsonPath("$.quotaBytes").value(104857600))
                .andExpect(jsonPath("$.usedBytes").value(0))
                .andExpect(jsonPath("$.createdAt").exists())
                .andExpect(jsonPath("$.updatedAt").exists());
    }

    @Test
    void meReturnsNotFoundForAnUnknownSubject() throws Exception {
        when(userService.meByAuthSub(eq("missing")))
                .thenThrow(new ResponseStatusException(NOT_FOUND, "User not Found"));

        mockMvc.perform(get("/user/me").header("X-User-AuthSub", "missing"))
                .andExpect(status().isNotFound());
    }

    private static User user(String authSub, String email, String name) {
        User user = new User(authSub, email, name);
        user.setId(UUID.randomUUID());
        OffsetDateTime now = OffsetDateTime.now();
        user.setCreatedAt(now);
        user.setUpdatedAt(now);
        return user;
    }
}
