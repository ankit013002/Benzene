package com.nebulavault.user_service.user;

import com.nebulavault.user_service.user.dto.UserProfileResponse;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;

@RestController
@RequestMapping("/user")
public class UserController {
    private final UserService userService;

    public UserController(UserService userService){
        this.userService = userService;
    }

    @PostMapping("/bootstrap")
    public ResponseEntity<UserProfileResponse> bootstrap(
            @RequestHeader("X-User-AuthSub") String authSub,
            @RequestHeader("X-User-Email") String email,
            @RequestHeader(value = "X-User-Name", required = false) String name
    ){
        var user = userService.bootstrap(authSub, email, name);
        return ResponseEntity.ok(UserProfileResponse.from(user));
    }

    @GetMapping("/me")
    public UserProfileResponse me(@RequestHeader("X-User-AuthSub") String authSub) {
        return UserProfileResponse.from(userService.meByAuthSub(authSub));
    }
}
