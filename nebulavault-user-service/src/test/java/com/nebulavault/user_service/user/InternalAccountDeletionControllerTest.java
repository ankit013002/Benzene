package com.nebulavault.user_service.user;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(InternalAccountDeletionController.class)
@Import(InternalServiceSecret.class)
@TestPropertySource(properties =
        "BENZENE_INTERNAL_SERVICE_SECRET=test-only-internal-secret-with-at-least-32-bytes")
class InternalAccountDeletionControllerTest {
    private static final String AUTH_SUB = "b03dba68-5928-446b-9054-80b5b0c9315e";
    private static final String SECRET =
            "test-only-internal-secret-with-at-least-32-bytes";

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private UserService userService;

    @Test
    void rejectsMissingOrInvalidInternalSecret() throws Exception {
        mockMvc.perform(delete("/internal/account-deletion/{authSub}", AUTH_SUB))
                .andExpect(status().isUnauthorized());

        mockMvc.perform(delete("/internal/account-deletion/{authSub}", AUTH_SUB)
                        .header("X-Benzene-Internal-Secret", SECRET + "wrong"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void acceptsTheInternalSecretAndReturnsSuccessWhenProfileIsAlreadyAbsent() throws Exception {
        mockMvc.perform(delete("/internal/account-deletion/{authSub}", AUTH_SUB)
                        .header("X-Benzene-Internal-Secret", SECRET))
                .andExpect(status().isNoContent());
        mockMvc.perform(delete("/internal/account-deletion/{authSub}", AUTH_SUB)
                        .header("X-Benzene-Internal-Secret", SECRET))
                .andExpect(status().isNoContent());

        verify(userService, org.mockito.Mockito.times(2))
                .deleteByAuthSub(AUTH_SUB);
    }
}
