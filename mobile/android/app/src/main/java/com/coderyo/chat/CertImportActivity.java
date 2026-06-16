package com.coderyo.chat;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * First-launch screen that imports the user's mTLS client certificate (.p12).
 * The UI is built in code to avoid shipping an XML layout for one screen.
 */
public class CertImportActivity extends AppCompatActivity {

    private Uri pickedUri;
    private TextView fileLabel;
    private EditText passwordInput;
    private TextView status;
    private ActivityResultLauncher<String[]> picker;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        picker = registerForActivityResult(
                new ActivityResultContracts.OpenDocument(),
                uri -> {
                    if (uri != null) {
                        pickedUri = uri;
                        fileLabel.setText("已選擇: " + uri.getLastPathSegment());
                    }
                });

        int pad = dp(20);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("匯入用戶端憑證");
        title.setTextSize(20);
        root.addView(title);

        TextView desc = new TextView(this);
        desc.setText("選擇你的 .p12 用戶端憑證並輸入密碼。憑證只會存在這支手機的 app 私有空間，"
                + "用來通過 Cloudflare mTLS，不會上傳也不會打包進 app。");
        desc.setPadding(0, dp(8), 0, dp(16));
        root.addView(desc);

        Button choose = new Button(this);
        choose.setText("選擇 .p12 檔案");
        choose.setOnClickListener(v -> picker.launch(new String[]{"*/*"}));
        root.addView(choose);

        fileLabel = new TextView(this);
        fileLabel.setText("尚未選擇檔案");
        fileLabel.setPadding(0, dp(8), 0, dp(16));
        root.addView(fileLabel);

        passwordInput = new EditText(this);
        passwordInput.setHint("憑證密碼");
        passwordInput.setInputType(
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        root.addView(passwordInput);

        Button importBtn = new Button(this);
        importBtn.setText("匯入並繼續");
        importBtn.setOnClickListener(v -> doImport());
        root.addView(importBtn);

        status = new TextView(this);
        status.setPadding(0, dp(16), 0, 0);
        root.addView(status);

        setContentView(root);
    }

    private void doImport() {
        if (pickedUri == null) {
            status.setText("請先選擇 .p12 檔案");
            return;
        }
        String password = passwordInput.getText().toString();
        try (InputStream in = getContentResolver().openInputStream(pickedUri)) {
            if (in == null) {
                status.setText("無法讀取選取的檔案");
                return;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
            CertStore.importP12(this, bos.toByteArray(), password);
            setResult(Activity.RESULT_OK);
            finish();
        } catch (Exception e) {
            status.setText("匯入失敗: " + e.getMessage());
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
