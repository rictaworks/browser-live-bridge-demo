Rails.application.routes.draw do
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # 中継層・フロントエンドと同じ流儀の稼働確認エンドポイントです。
  get "health" => "health#show"

  # 配信者向けAPI（Cookieセッションスコープ）。
  namespace :api do
    resources :broadcasts, only: %i[create show] do
      member do
        post :sources
        post "lock/heartbeat", action: "heartbeat"
        post :stop
        get :audience
        post :chat
        get :events
      end
    end
  end

  # 中継（Gin）からの内部API。Railway内部通信のみを想定し、外部公開しない。
  namespace :internal do
    post "broadcasts/verify", to: "broadcasts#verify"
    post "broadcasts/:id/health_samples", to: "broadcasts#health_samples"
    post "broadcasts/:id/events", to: "broadcasts#events"
    post "broadcasts/:id/finish", to: "broadcasts#finish"
  end

  # Defines the root path route ("/")
  # root "posts#index"
end
